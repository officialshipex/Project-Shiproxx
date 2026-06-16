/**
 * autoNdrAiCall.js
 *
 * Shared helper: automatically triggers an AI follow-up call to the customer
 * when an order's ndrStatus transitions to "Undelivered" (first failed delivery).
 *
 * Called from tracking controllers AFTER order.save() so it is fully non-blocking.
 */

const axios = require("axios");
const AiCallLog = require("../models/aiCalling.model");
const NotificationSetting = require("../notification/notification.model");
const User = require("../models/User.model");
const Wallet = require("../models/wallet");

const ECHQ_API_URL = "https://app.echqlabs.com/api/singlecampaign";
const ECHQ_API_KEY = process.env.ECHQ_API_KEY || "";
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || "https://api.shiproxx.com";
const SERVICE_ID_NDR_FOLLOWUP = 21;

/**
 * Auto-trigger AI NDR follow-up call if the user has enabled it.
 * @param {Object} order - Mongoose order document (already saved)
 * @param {string} newNdrStatus - The new ndrStatus value just set
 */
const autoTriggerNdrAiCall = async (order, newNdrStatus) => {
  // Only fire when status is Undelivered AND reattempt is true
  if (newNdrStatus !== "Undelivered") return;
  if (!order || !order.reattempt) return;
  if (!order.userId) return;

  try {
    // Check if AI NDR calling is enabled for this user
    const setting = await NotificationSetting.findOne({ userId: order.userId }).lean();
    if (!setting) return;
    if (!setting.isAiNdrFollowupEnable) return;
    if (setting.isAdminAiNdrFollowupEnable === false) return;

    // ── Prevent duplicate calls: skip if we already called for this order's latest NDR ──
    const lastLog = await AiCallLog.findOne({
      orderId: order._id,
      serviceType: "ndr_followup",
      callStatus: { $in: ["pending", "answered", "unanswered"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (lastLog) {
      // Already called recently — don't repeat
      const minutesSinceLastCall = (Date.now() - new Date(lastLog.createdAt).getTime()) / 60000;
      if (minutesSinceLastCall < 60) {
        // Within 60 minutes — skip duplicate
        return;
      }
    }

    const phone = order.receiverAddress?.phoneNumber;
    if (!phone) return;

    // Create a pending log entry first
    const logEntry = await AiCallLog.create({
      userId: order.userId,
      orderId: order._id,
      awb_number: order.awb_number,
      orderDisplayId: order.orderId,
      serviceType: "ndr_followup",
      calledNumber: phone,
      callStatus: "pending",
    });

    // Build the EchQ API payload according to Postman docs
    const campaignName = `AUTO_NDR_${new Date().toISOString().split('T')[0]}_${order.orderId}`;
    const payload = {
      campaign_name: campaignName,
      service_id: 21,
      calling_name: order.receiverAddress?.contactName || "Customer",
      calling_number: phone.replace(/\D/g, "").slice(-10),
      callback_url: `${BACKEND_PUBLIC_URL}/ai-calling/callback`,
      calling_data: {
        brand_name: "Shiproxx",
        product_name: order.productDetails?.[0]?.name || "Package",
        order_number: order.orderId?.toString(),
        order_type: order.paymentDetails?.method || "COD",
        cod_amount: order.paymentDetails?.method === "COD" ? (order.paymentDetails?.amount || 0).toString() : "0",
        order_amount: (order.paymentDetails?.amount || 0).toString(),
        courier_name: order.courierServiceName || "N/A",
        tracking_no: order.awb_number || "",
      }
    };

    // Call EchQ — non-blocking, errors are swallowed
    try {
      const echqResponse = await axios.post(ECHQ_API_URL, payload, {
        headers: {
          "Content-Type": "application/json",
          signature: ECHQ_API_KEY,
          Authorization: `Bearer ${ECHQ_API_KEY}`,
        },
        timeout: 12000,
      });

      const callId =
        echqResponse?.data?.call_id || echqResponse?.data?.message_id;

      await AiCallLog.findByIdAndUpdate(logEntry._id, { callId });
      console.log(`✅ Auto AI NDR call initiated for AWB: ${order.awb_number}, callId: ${callId}`);
    } catch (apiErr) {
      await AiCallLog.findByIdAndUpdate(logEntry._id, {
        callStatus: "failed",
        errorMessage: apiErr?.response?.data?.message || apiErr.message,
      });
      console.warn(`⚠️ Auto AI NDR call failed for ${order.awb_number}: ${apiErr.message}`);
    }
  } catch (err) {
    // Never throw — this must never break the main webhook/tracking flow
    console.error("❌ autoTriggerNdrAiCall error:", err.message);
  }
};

module.exports = { autoTriggerNdrAiCall };
