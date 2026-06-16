const axios = require("axios");
const AiCallLog = require("../models/aiCalling.model");
const Order = require("../models/newOrder.model");
const User = require("../models/User.model");
const Wallet = require("../models/wallet");
const NotificationSetting = require("../notification/notification.model");
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────
// EchQ API Config
// ─────────────────────────────────────────────────────────
const ECHQ_API_URL = "https://app.echqlabs.com/api/singlecampaign"; // adjust if different
const ECHQ_API_KEY = process.env.ECHQ_API_KEY || "";
const BACKEND_URL = process.env.BACKEND_PUBLIC_URL || "https://api.shiproxx.com";

const SERVICE_ID_ORDER_VERIFY = 22;
const SERVICE_ID_NDR_FOLLOWUP = 21;

// ─────────────────────────────────────────────────────────
// Helper: Get user wallet creditBalance
// ─────────────────────────────────────────────────────────
const getUserCreditBalance = async (userId) => {
  const user = await User.findById(userId).select("Wallet");
  if (!user?.Wallet) return 0;
  const wallet = await Wallet.findById(user.Wallet).select("creditBalance");
  return wallet?.creditBalance || 0;
};

// ─────────────────────────────────────────────────────────
// Helper: Check if AI calling is enabled for user
// ─────────────────────────────────────────────────────────
const isAiCallingEnabled = async (userId, serviceType) => {
  const setting = await NotificationSetting.findOne({ userId }).lean();
  if (!setting) return false;
  if (serviceType === "order_verification") {
    return setting.isAdminAiOrderVerifyEnable !== false && setting.isAiOrderVerifyEnable === true;
  }
  if (serviceType === "ndr_followup") {
    return setting.isAdminAiNdrFollowupEnable !== false && setting.isAiNdrFollowupEnable === true;
  }
  return false;
};

// ─────────────────────────────────────────────────────────
// POST /ai-calling/initiate
// Body: { orderId, serviceType, orderIds (for bulk) }
// ─────────────────────────────────────────────────────────
const initiateAiCall = async (req, res) => {
  try {
    const { orderId, serviceType, orderIds } = req.body;
    console.log("AI Call Request:", { orderId, serviceType, orderIds });

    if (!serviceType || !["order_verification", "ndr_followup"].includes(serviceType)) {
      return res.status(400).json({ success: false, message: "Invalid service type" });
    }

    const ids = orderIds?.length > 0 ? orderIds : orderId ? [orderId] : [];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: "No order(s) provided" });
    }

    const results = [];
    const userCache = new Map(); // Cache settings/balance to minimize DB calls for the same user in bulk

    for (const oid of ids) {
      try {
        const order = await Order.findById(oid);
        if (!order) {
          results.push({ orderId: oid, success: false, message: "Order not found" });
          continue;
        }

        const userId = order.userId;
        if (!userId) {
          results.push({ orderId: oid, awb: order.awb_number, success: false, message: "Order has no associated user" });
          continue;
        }

        // Security Check: If not admin, the requester must be the owner of the order
        if (!req.user.isAdmin && req.user._id.toString() !== userId.toString()) {
          results.push({ orderId: oid, awb: order.awb_number, success: false, message: "Unauthorized" });
          continue;
        }

        // Check cache or DB for user settings/balance
        const uidStr = userId.toString();
        if (!userCache.has(uidStr)) {
          const [enabled, balance] = await Promise.all([
            isAiCallingEnabled(userId, serviceType),
            getUserCreditBalance(userId),
          ]);
          userCache.set(uidStr, { enabled, balance, usedInBatch: 0 });
        }

        const uCtx = userCache.get(uidStr);

        if (!uCtx.enabled) {
          results.push({ orderId: oid, awb: order.awb_number, success: false, message: "AI Calling is not enabled for this user" });
          continue;
        }

        if (uCtx.balance - uCtx.usedInBatch < 1) {
          results.push({ orderId: oid, awb: order.awb_number, success: false, message: `Insufficient credits (Balance: ${uCtx.balance})` });
          continue;
        }

        // For NDR: only proceed if order has ndrStatus = "Action Required"
        if (serviceType === "ndr_followup") {
          const eligibleNdrStatuses = ["Action Required", "Action_Required"];
          if (!eligibleNdrStatuses.includes(order.ndrStatus)) {
            results.push({ orderId: oid, awb: order.awb_number, success: false, message: "Order not eligible for NDR follow-up" });
            continue;
          }
        }

        // For order_verification: order must be in "Booked" status
        if (serviceType === "order_verification") {
          if (order.status !== "Booked") {
            results.push({ orderId: oid, awb: order.awb_number, success: false, message: "Order must be in Booked status for verification" });
            continue;
          }
        }

        const phone = order.receiverAddress?.phoneNumber;
        if (!phone) {
          results.push({ orderId: oid, awb: order.awb_number, success: false, message: "Customer phone number not available" });
          continue;
        }

        // Build callback URL
        const callbackUrl = `${BACKEND_URL}/ai-calling/callback`;

        // Build EchQ API payload based on Postman documentation
        const campaignName = `${serviceType.toUpperCase()}_${new Date().toISOString().split('T')[0]}_${order.orderId}`;

        let callingData = {
          brand_name: "Shiproxx",
          product_name: order.productDetails?.[0]?.name || "Package",
          order_number: order.orderId?.toString(),
          order_type: order.paymentDetails?.method || "COD",
          cod_amount: order.paymentDetails?.method === "COD" ? (order.paymentDetails?.amount || 0).toString() : "0",
        };

        if (serviceType === "ndr_followup") {
          callingData = {
            ...callingData,
            order_amount: (order.paymentDetails?.amount || 0).toString(),
            courier_name: order.courierServiceName || "N/A",
            tracking_no: order.awb_number || "",
          };
        } else {
          // order_verification
          callingData = {
            ...callingData,
            delivery_address: order.receiverAddress?.address || "",
            delivery_city: order.receiverAddress?.city || "",
          };
        }

        const payload = {
          campaign_name: campaignName,
          service_id: serviceType === "order_verification" ? 22 : 21,
          calling_name: order.receiverAddress?.contactName || "Customer",
          calling_number: phone.replace(/\D/g, "").slice(-10), // ensures exactly 10 digits
          callback_url: callbackUrl,
          calling_data: callingData
        };

        // Create a pending log before calling EchQ
        const logEntry = await AiCallLog.create({
          userId,
          orderId: order._id,
          awb_number: order.awb_number,
          orderDisplayId: order.orderId,
          serviceType,
          calledNumber: phone,
          callStatus: "pending",
        });

        // Call EchQ API
        let echqResponse;
        try {
          console.log("Sending call to EchQ:", { 
            url: ECHQ_API_URL, 
            payload, 
            signatureStatus: ECHQ_API_KEY ? "EXISTS" : "MISSING" 
          });
          echqResponse = await axios.post(ECHQ_API_URL, payload, {
            headers: {
              "Content-Type": "application/json",
              signature: ECHQ_API_KEY,
              Authorization: `Bearer ${ECHQ_API_KEY}`,
            },
            timeout: 15000,
          });
          console.log("echqResponse", echqResponse.data.message)
        } catch (apiErr) {
          console.log("echq error", apiErr.message)
          // EchQ API failed — update log with error
          await AiCallLog.findByIdAndUpdate(logEntry._id, {
            callStatus: "failed",
            errorMessage: apiErr?.response?.data?.message || apiErr.message,
          });
          results.push({ orderId: oid, awb: order.awb_number, success: false, message: "Failed to initiate call via EchQ" });
          continue;
        }

        // Update log with call_id
        const callId = echqResponse?.data?.call_id || echqResponse?.data?.message_id;
        await AiCallLog.findByIdAndUpdate(logEntry._id, { callId });

        results.push({ orderId: oid, awb: order.awb_number, success: true, callId, message: "Call initiated successfully" });
        uCtx.usedInBatch++;
      } catch (innerErr) {
        console.error("AI Call inner error:", innerErr.message);
        results.push({ orderId: oid, success: false, message: innerErr.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    return res.json({
      success: true,
      message: `${successCount}/${ids.length} call(s) initiated`,
      results,
    });
  } catch (error) {
    console.error("❌ AI Call initiation error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────
// POST /ai-calling/callback  (public — called by EchQ)
// EchQ sends call result here after call is completed
// ─────────────────────────────────────────────────────────
const aiCallCallback = async (req, res) => {
  try {
    const data = req.body;
    console.log("📞 AI Calling Callback received:", JSON.stringify(data));

    // EchQ sends call_id / message_id to identify the call
    const callId = data?.call_id || data?.message_id;
    if (!callId) {
      return res.status(400).json({ success: false, message: "call_id missing" });
    }

    // Find the log
    const logEntry = await AiCallLog.findOne({ callId });
    if (!logEntry) {
      console.warn("⚠️ No call log found for callId:", callId);
      return res.status(404).json({ success: false, message: "Call log not found" });
    }

    const callStatus = data?.status?.toLowerCase() || "failed"; // "answered" | "unanswered" | "failed"
    const customerResponse = data?.customer_response || data?.response || "";
    const recordingUrl = data?.recording_url || data?.recordingUrl || "";

    // Update the log
    await AiCallLog.findByIdAndUpdate(logEntry._id, {
      callStatus,
      customerResponse,
      recordingUrl,
      callbackData: data,
    });

    // ─── Only deduct credit if call was ANSWERED ───
    if (callStatus === "answered") {
      try {
        const user = await User.findById(logEntry.userId).select("Wallet");
        if (user?.Wallet) {
          const wallet = await Wallet.findById(user.Wallet).select("creditBalance notificationTransactions");
          if (wallet && wallet.creditBalance > 0) {
            wallet.creditBalance = Math.max(0, wallet.creditBalance - 1);
            wallet.notificationTransactions.push({
              channelOrderId: logEntry.awb_number || logEntry.orderId?.toString(),
              category: "debit",
              amount: 1,
              description: `Call Debit - ${logEntry.serviceType === "order_verification" ? "Verification" : "NDR Follow-up"} (${logEntry.awb_number || logEntry.orderDisplayId})`,
              balanceAfterTransaction: wallet.creditBalance,
              date: new Date(),
            });
            await wallet.save();
            await AiCallLog.findByIdAndUpdate(logEntry._id, { creditDeducted: true });
          }
        }
      } catch (walletErr) {
        console.error("❌ Wallet deduction failed:", walletErr.message);
      }

      // ─── Update order based on service type & customer response ───
      try {
        const order = await Order.findById(logEntry.orderId);
        if (order) {
          if (logEntry.serviceType === "order_verification") {
            // Customer confirmed delivery / address correct
            const confirmed = isPositiveResponse(customerResponse);
            // No longer updating tracking history as per request
            order.ndrHistory.push({
              actions: [
                {
                  action: confirmed ? "Address Verified" : "Address Issue Reported",
                  actionBy: "Shiproxx",
                  remark: customerResponse || "No response captured",
                  source: "Shiproxx",
                  date: new Date(),
                },
              ],
            });
            await order.save();
            await AiCallLog.findByIdAndUpdate(logEntry._id, { orderUpdated: true });
          } else if (logEntry.serviceType === "ndr_followup") {
            // Map customer response to NDR action
            const ndrAction = mapResponseToNdrAction(customerResponse);

            // Update ndrHistory only as per request (no tracking push)
            order.ndrHistory.push({
              actions: [
                {
                  action: ndrAction,
                  actionBy: "Shiproxx",
                  remark: customerResponse || "",
                  source: "Shiproxx",
                  date: new Date(),
                },
              ],
            });

            // If customer wants re-attempt
            if (ndrAction.toLowerCase().includes("re-attempt") || ndrAction.toLowerCase().includes("reattempt")) {
              order.ndrStatus = "Reattempt Requested";
            }

            await order.save();
            await AiCallLog.findByIdAndUpdate(logEntry._id, { orderUpdated: true });
          }
        }
      } catch (orderErr) {
        console.error("❌ Order update from callback failed:", orderErr.message);
      }
    }

    return res.json({ success: true, message: "Callback processed" });
  } catch (error) {
    console.error("❌ AI Callback error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─── Helper: Is customer response positive ───
const isPositiveResponse = (response = "") => {
  const r = response.toLowerCase();
  return r.includes("yes") || r.includes("confirm") || r.includes("correct") || r.includes("ok");
};

// ─── Helper: Map response to NDR action ───
const mapResponseToNdrAction = (response = "") => {
  const r = response.toLowerCase();
  if (r.includes("deliver") || r.includes("re-attempt") || r.includes("reattempt") || r.includes("yes")) return "Re-Attempt";
  if (r.includes("return") || r.includes("rto") || r.includes("cancel")) return "RTO Requested";
  if (r.includes("address")) return "Address Change Requested";
  return "Follow-up Done";
};

// ─────────────────────────────────────────────────────────
// GET /ai-calling/logs   — Fetch AI call logs for a user
// ─────────────────────────────────────────────────────────
const getAiCallLogs = async (req, res) => {
  try {
    let targetUserId = req.query.userId || (req.user ? req.user._id : null);
    if (!targetUserId) return res.status(400).json({ error: "User ID required" });

    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      const u = await User.findOne({ userId: targetUserId });
      if (u) targetUserId = u._id;
      else return res.status(404).json({ error: "User not found" });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { serviceType, callStatus } = req.query;

    const query = { userId: targetUserId };
    if (serviceType) query.serviceType = serviceType;
    if (callStatus) query.callStatus = callStatus;

    const [logs, total] = await Promise.all([
      AiCallLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AiCallLog.countDocuments(query),
    ]);

    return res.json({ success: true, logs, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error("❌ Get AI call logs error:", error.message);
    return res.status(500).json({ error: error.message });
  }
};

// ─────────────────────────────────────────────────────────
// GET /ai-calling/settings  → gets isAiOrderVerifyEnable, isAiNdrFollowupEnable
// PUT /ai-calling/settings  → update those toggles
// ─────────────────────────────────────────────────────────
const getAiCallingSettings = async (req, res) => {
  try {
    let targetUserId = req.query.userId || (req.user ? req.user._id : null);
    if (!targetUserId) return res.status(400).json({ error: "User ID required" });

    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      const u = await User.findOne({ userId: targetUserId });
      if (u) targetUserId = u._id;
      else return res.status(404).json({ error: "User not found" });
    } 

    let setting = await NotificationSetting.findOne({ userId: targetUserId });
    if (!setting) {
      setting = new NotificationSetting({ userId: targetUserId });
      await setting.save();
    }

    return res.json({
      success: true,
      isAiOrderVerifyEnable: setting.isAiOrderVerifyEnable || false,
      isAdminAiOrderVerifyEnable: setting.isAdminAiOrderVerifyEnable !== false,
      isAiNdrFollowupEnable: setting.isAiNdrFollowupEnable || false,
      isAdminAiNdrFollowupEnable: setting.isAdminAiNdrFollowupEnable !== false,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const updateAiCallingSettings = async (req, res) => {
  try {
    const { userId, field, value } = req.body;
    let targetUserId = userId || (req.user ? req.user._id : null);
    if (!targetUserId) return res.status(400).json({ error: "User ID required" });

    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      const u = await User.findOne({ userId: targetUserId });
      if (u) targetUserId = u._id;
    }

    const allowedFields = [
      "isAiOrderVerifyEnable",
      "isAiNdrFollowupEnable",
      "isAdminAiOrderVerifyEnable",
      "isAdminAiNdrFollowupEnable",
    ];
    if (!allowedFields.includes(field)) {
      return res.status(400).json({ error: "Invalid field" });
    }

    await NotificationSetting.findOneAndUpdate(
      { userId: targetUserId },
      { $set: { [field]: value } },
      { upsert: true, new: true }
    );

    return res.json({ success: true, message: "Setting updated" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  initiateAiCall,
  aiCallCallback,
  getAiCallLogs,
  getAiCallingSettings,
  updateAiCallingSettings,
};
