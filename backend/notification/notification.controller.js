const axios = require("axios");
const NotificationSetting = require("./notification.model");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const NewOrder = require("../models/newOrder.model");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
const MessageLog = require("./messageCheck.model");

// Working email configuration imported from central config
const transporter = require("./configEmailpass");

const getNotificationSettings = async (req, res) => {
  try {
    // Priority: Query param (for admin) > Authenticated user
    let targetUserId = req.query.userId || (req.user ? req.user._id : null);

    if (!targetUserId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // Handle case where targetUserId might be a string but needs to be an ObjectId
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      // If it's a numeric userId, we should find the user first
      const User = require("../models/User.model");
      const user = await User.findOne({ userId: targetUserId });
      if (user) {
        targetUserId = user._id;
      } else {
        return res.status(404).json({ error: "User not found" });
      }
    }

    let setting = await NotificationSetting.findOne({ userId: targetUserId });
    if (!setting) {
      setting = new NotificationSetting({ userId: targetUserId });
      await setting.save();
    }
    res.json(setting);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateNotificationSetting = async (req, res) => {
  try {
    const { userId, field, value, subject, template } = req.body;
    let targetUserId = userId || (req.user ? req.user._id : null);

    if (!targetUserId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      const User = require("../models/User.model");
      const user = await User.findOne({ userId: targetUserId });
      if (user) targetUserId = user._id;
    }

    const setting = await NotificationSetting.findOne({ userId: targetUserId });
    if (!setting) {
      return res.status(404).json({ error: "Notification settings not found" });
    }

    if (field) {
      // Handle status-specific updates
      // The frontend might pass 'whatsappPickupPending' as field, and we need to update toggles/templates

      if (typeof value !== "undefined") {
        // Master toggles or specific toggles
        setting[field] = value;
        const updatedAtField = field.replace("is", "").replace("Enable", "UpdatedAt");
        if (setting.schema.paths[updatedAtField]) {
          setting[updatedAtField] = new Date();
        }
      }

      // Handle template and subject updates
      if (typeof template !== "undefined") {
        // field might be 'whatsappPickupPending'
        setting[`${field}Template`] = template;
        setting[`${field}UpdatedAt`] = new Date();
      }

      if (typeof subject !== "undefined") {
        setting[`${field}Subject`] = subject;
      }
    }

    await setting.save();
    res.json(setting);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const buyCredits = async (req, res) => {
  try {
    const { amount, userId } = req.body;
    if (!amount || isNaN(amount)) return res.status(400).json({ error: "Invalid amount" });

    const targetUserId = userId || (req.user ? req.user._id : null);
    if (!targetUserId) return res.status(400).json({ error: "User ID is required" });

    const User = require("../models/User.model");
    const user = await User.findById(targetUserId).select("Wallet");
    if (!user || !user.Wallet) return res.status(404).json({ error: "Wallet not found" });

    const wallet = await Wallet.findById(user.Wallet).select("balance creditBalance notificationTransactions");
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const purchaseAmount = Number(amount);

    // 1. Check if main wallet balance is sufficient
    if (wallet.balance < purchaseAmount) {
      return res.status(400).json({ error: "Insufficient wallet balance to buy notification credits" });
    }

    // 2. Deduct from main wallet balance
    wallet.balance -= purchaseAmount;

    // 3. Add to notification credit balance
    wallet.creditBalance += purchaseAmount;

    // 4. Record DEBIT in main passbook (transactions)
    const transactionId = Math.floor(10000000 + Math.random() * 90000000).toString();
    await WalletTransaction.create({
      walletId: wallet._id,
      channelOrderId: transactionId,
      category: "debit",
      amount: purchaseAmount,
      description: `Notification Credits Purchased`,
      balanceAfterTransaction: wallet.balance,
    });

    // 5. Record CREDIT in notificationTransactions history
    wallet.notificationTransactions.push({
      channelOrderId: transactionId,
      category: "credit",
      amount: purchaseAmount,
      description: `Notification Credit Applied`,
      balanceAfterTransaction: wallet.creditBalance,
      date: new Date(),
    });

    await wallet.save();
    res.json({
      success: true,
      message: "Credits purchased successfully",
      creditBalance: wallet.creditBalance,
      walletBalance: wallet.balance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getCreditBalance = async (req, res) => {
  try {
    const User = require("../models/User.model");
    const targetUserId = req.query.userId || (req.user ? req.user._id : null);
    if (!targetUserId) return res.status(400).json({ error: "User ID is required" });

    const user = await User.findById(targetUserId).select("Wallet");
    if (!user || !user.Wallet) {
      return res.json({ creditBalance: 0 });
    }
    const wallet = await Wallet.findById(user.Wallet).select("creditBalance");
    res.json({ creditBalance: wallet ? wallet.creditBalance : 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getUserPassbookTransactions = async (req, res) => {
  try {
    const User = require("../models/User.model");
    const targetUserId = req.query.userId || (req.user ? req.user._id : null);
    if (!targetUserId) return res.status(400).json({ error: "User ID is required" });

    const user = await User.findById(targetUserId).select("Wallet");
    if (!user || !user.Wallet) return res.json({ results: [], total: 0 });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const { category, description, orderId, awbNumber, fromDate, toDate } = req.query;

    const wallet = await Wallet.findById(user.Wallet).lean().select("notificationTransactions");
    if (!wallet || !wallet.notificationTransactions) return res.json({ results: [], total: 0 });

    let filteredTransactions = wallet.notificationTransactions;

    if (category) {
      filteredTransactions = filteredTransactions.filter(t => t.category === category);
    }
    if (description) {
      filteredTransactions = filteredTransactions.filter(t => t.description && t.description.toLowerCase().includes(description.toLowerCase()));
    }
    if (orderId) {
      filteredTransactions = filteredTransactions.filter(t => t.channelOrderId === orderId || t.orderId === orderId);
    }
    if (awbNumber) {
      filteredTransactions = filteredTransactions.filter(t => t.channelOrderId === awbNumber || t.awb_number === awbNumber); // channelOrderId is used as awb_number in notifications
    }
    if (fromDate && toDate) {
      const start = new Date(fromDate);
      const end = new Date(toDate);
      filteredTransactions = filteredTransactions.filter(t => {
        const tDate = new Date(t.date);
        return tDate >= start && tDate <= end;
      });
    }

    // 🔹 Now directly reading from the isolated Notification key
    const sortedTransactions = filteredTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    const paginatedTransactions = sortedTransactions.slice(skip, skip + limit);

    res.json({
      results: paginatedTransactions,
      total: filteredTransactions.length,
      page,
      limit,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const statuses = [
  {
    key: "Booked",
    label: "Booked",
    template: "Your order {order_id} has been successfully booked. Track: {tracking_link}",
  },
  {
    key: "Ready To Ship",
    label: "Pickup Pending",
    template: "Dear Customer, your order has been created and is pending pickup. We'll notify you once it’s picked up. Track: {tracking_link}",
  },
  {
    key: "Pickup Completed",
    label: "Pickup Completed",
    template: "Your order has been picked up successfully. Track: {tracking_link}",
  },
  {
    key: "In-transit",
    label: "In Transit",
    template: "Good news! Your order is on the way and currently in transit. Track your package here: {tracking_link}",
  },
  {
    key: "Out for Delivery",
    label: "Out for Delivery",
    template: "Your order is out for delivery. Please keep your phone available. Track: {tracking_link}",
  },
  {
    key: "Delivered",
    label: "Delivered",
    template: "Your order has been successfully delivered. Thank you for choosing us!",
  },
  {
    key: "Undelivered",
    label: "Undelivered",
    template: "Delivery attempt was unsuccessful. We will retry soon. Track your shipment: {tracking_link}",
  },
  {
    key: "RTO",
    label: "RTO Initiated",
    template: "Your order is being returned to the sender (RTO initiated). You can track it here: {tracking_link}",
  },
  {
    key: "Cancelled",
    label: "Cancelled",
    template: "Your order has been cancelled. If you have any questions, please contact support. Order ID: {order_id}",
  },
];

const sendWhatsAppMessage = async ({
  userId,
  credit,
  awb_number,
  status,
  date,
  mobile_number,
}) => {
  try {
    if (!mobile_number || !status) return { success: false };

    const setting = await NotificationSetting.findOne({ userId }).lean();

    if (!setting) {
      const reason = `Notification settings not found for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    const checkLog = await MessageLog.findOne({ awb_number, status });
    if (checkLog?.isWhatsAppSent) {
      const reason = `WhatsApp already sent for AWB: ${awb_number}, status: ${status}. Skipping.`;
      console.log(`ℹ️ ${reason}`);
      return { success: true, alreadySent: true, reason };
    }

    const statusFieldMap = {
      "Booked": "isWhatsAppBookedEnable",
      "Ready To Ship": "isWhatsAppPickupPendingEnable",
      "Pickup Completed": "isWhatsAppPickupCompletedEnable",
      "In-transit": "isWhatsAppIntransitEnable",
      "Out for Delivery": "isWhatsAppOutForDeliveryEnable",
      Delivered: "isWhatsAppDeliveredEnable",
      Undelivered: "isWhatsAppUndeliveredEnable",
      RTO: "isWhatsAppRTOEnable",
      "Cancelled": "isWhatsAppCancelledEnable", // Need to add to model if not present
    };

    const fieldName = statusFieldMap[status];

    // Admin restrictions (Must be enabled by Admin default)
    if (setting.isAdminWhatsAppEnable === false) {
      const reason = `WhatsApp blocked by Admin for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    // User restrictions (Must be explicitly turned on by user)
    if (setting.isUserWhatsAppEnable === false) {
      const reason = `WhatsApp disabled by User for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }
    if (!fieldName) {
      console.log(`❌ No WhatsApp status field mapping for status: ${status}`);
      return { success: false };
    }
    if (!setting[fieldName]) {
      const reason = `WhatsApp notification for ${status} is disabled in user settings.`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    // Credit restriction
    if (!credit || credit <= 0) {
      const reason = `Insufficient credits for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    const matchedStatus = statuses.find((s) => s.key === status);
    if (!matchedStatus) return { success: false };

    const statusKey = fieldName.replace("isWhatsApp", "").replace("Enable", "");
    const userTemplate = setting[`whatsapp${statusKey}Template`];
    const templateToUse = userTemplate || matchedStatus.template;

    const tracking_link = `https://www.shiproxx.com/track/${awb_number}`;
    const messageBody = templateToUse
      .replace(/{tracking_link}/g, tracking_link)
      .replace(/{order_id}/g, awb_number)
      .replace(/{customer_name}/g, "Customer");

    const payload = {
      phoneNoId: process.env.WHATSAPP_NUMBER_ID,
      to: mobile_number,
      type: "text",
      text: messageBody,
    };

    // ✅ Send via API
    const response = await axios.post(
      `${process.env.WHATSAPP_BASE_URL}/v2/whatsapp-business/messages`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.WHATSAPP_API_KEY}`,
        },
      }
    );
    console.log("whatsapp response", response.data)

    if (response.status === 200 || response.status === 201) {
      // 🔹 Debit logic: Deduct 1 credit for success
      const User = require("../models/User.model");
      const userWithWallet = await User.findById(userId).select("Wallet");
      if (userWithWallet?.Wallet) {
        const Wallet = require("../models/wallet");
        const wallet = await Wallet.findById(userWithWallet.Wallet).select("creditBalance notificationTransactions");
        if (wallet) {
          wallet.creditBalance = Math.max(0, wallet.creditBalance - 1);
          wallet.notificationTransactions.push({
            channelOrderId: logEntry.awb_number || logEntry.orderId?.toString(),
            category: "debit",
            amount: 1,
            description: `Call Debit - Verification (${logEntry.awb_number || logEntry.orderDisplayId})`,
            balanceAfterTransaction: wallet.creditBalance,
            date: new Date(),
          });
          await wallet.save();
        }
      }

      // 🔹 Update MessageLog
      await MessageLog.updateOne(
        { awb_number, status },
        { $set: { isWhatsAppSent: true, userId } },
        { upsert: true }
      );

      return { success: true };
    }

    return { success: false };
  } catch (error) {
    console.error("❌ Error sending WhatsApp message:", error.response?.data || error.message);
    return { success: false };
  }
};

const sendEmailMessage = async ({
  userId,
  credit,
  awb_number,
  status,
  date,
  email,
}) => {
  try {
    if (!email || !status) return { success: false };

    const setting = await NotificationSetting.findOne({ userId }).lean();
    if (!setting) return { success: false };

    // 🔹 Double Check Duplicate with MessageLog
    const checkLog = await MessageLog.findOne({ awb_number, status });
    if (checkLog?.isEmailSent) {
      const reason = `Email already sent for AWB: ${awb_number}, status: ${status}. Skipping.`;
      console.log(`ℹ️ ${reason}`);
      return { success: true, alreadySent: true, reason };
    }

    const statusFieldMap = {
      "Booked": "isEmailBookedEnable",
      "Ready To Ship": "isEmailPickupPendingEnable",
      "Pickup Completed": "isEmailPickupCompletedEnable",
      "In-transit": "isEmailIntransitEnable",
      "Out for Delivery": "isEmailOutForDeliveryEnable",
      Delivered: "isEmailDeliveredEnable",
      Undelivered: "isEmailUndeliveredEnable",
      RTO: "isEmailRTOEnable",
      "Cancelled": "isEmailCancelledEnable",
    };

    const fieldName = statusFieldMap[status];

    // Admin restrictions
    if (setting.isAdminEmailEnable === false) {
      const reason = `Email blocked by Admin for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    // User restrictions
    if (setting.isUserEmailEnable === false) {
      const reason = `Email disabled by User for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }
    if (!fieldName) {
      console.log(`❌ No Email status field mapping for status: ${status}`);
      return { success: false };
    }
    if (!setting[fieldName]) {
      const reason = `Email notification for ${status} is disabled in user settings.`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    // Email is free, so we skip the credit restriction check here.


    const matchedStatus = statuses.find((s) => s.key === status);
    if (!matchedStatus) return { success: false };

    const statusKey = fieldName.replace("isEmail", "").replace("Enable", "");
    const userTemplate = setting[`email${statusKey}Template`];
    const userSubject = setting[`email${statusKey}Subject`];
    const templateToUse = userTemplate || matchedStatus.template;
    const subjectToUse = userSubject || `Shiproxx | ${matchedStatus.label}`;

    const tracking_link = `https://www.shiproxx.com/track/${awb_number}`;
    const messageBody = templateToUse
      .replace(/{tracking_link}/g, tracking_link)
      .replace(/{order_id}/g, awb_number)
      .replace(/{customer_name}/g, "Customer");

    const info = await transporter.sendMail({
      from: '"Shiproxx Team" <info@shiproxx.com>',
      to: email,
      subject: subjectToUse,
      html: `<div style="font-family: Arial, sans-serif; padding: 20px;"><h2>${matchedStatus.label}</h2><p>${messageBody}</p><a href="${tracking_link}">Track Shipment</a></div>`,
    });
    console.log("email response", info)
    if (info && info.messageId) {
      // Email is free, so we don't debit any credits.


      // 🔹 Update MessageLog
      await MessageLog.updateOne(
        { awb_number, status },
        { $set: { isEmailSent: true, userId } },
        { upsert: true }
      );

      return { success: true };
    }

    return { success: false };
  } catch (error) {
    console.error("❌ Error sending email:", error.message);
    return { success: false };
  }
};

const sendSMSMessage = async ({
  userId,
  credit,
  awb_number,
  status,
  date,
  mobile_number,
}) => {
  try {
    if (!mobile_number || !status) return { success: false };

    const setting = await NotificationSetting.findOne({ userId }).lean();
    if (!setting) return { success: false };

    // 🔹 Double Check Duplicate with MessageLog
    const checkLog = await MessageLog.findOne({ awb_number, status });
    if (checkLog?.isSMSSent) {
      const reason = `SMS already sent for AWB: ${awb_number}, status: ${status}. Skipping.`;
      console.log(`ℹ️ ${reason}`);
      return { success: true, alreadySent: true, reason };
    }

    const statusFieldMap = {
      "Booked": "isSMSBookedEnable",
      "Ready To Ship": "isSMSPickupPendingEnable",
      "Pickup Completed": "isSMSPickupCompletedEnable",
      "In-transit": "isSMSIntransitEnable",
      "Out for Delivery": "isSMSOutForDeliveryEnable",
      "Delivered": "isSMSDeliveredEnable",
      "Undelivered": "isSMSUndeliveredEnable",
      "RTO": "isSMSRTOEnable",
      "Cancelled": "isSMSCancelledEnable",
    };

    const fieldName = statusFieldMap[status];

    // Admin restrictions
    if (setting.isAdminSMSEnable === false) {
      const reason = `SMS blocked by Admin for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    // User restrictions
    if (setting.isUserSMSEnable === false) {
      const reason = `SMS disabled by User for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }
    if (!fieldName) {
      console.log(`❌ No SMS status field mapping for status: ${status}`);
      return { success: false };
    }
    if (!setting[fieldName]) {
      const reason = `SMS notification for ${status} is disabled in user settings.`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    // Credit restriction
    if (!credit || credit <= 0) {
      const reason = `Insufficient credits for user: ${userId}`;
      console.log(`❌ ${reason}`);
      return { success: false, reason };
    }

    const matchedStatus = statuses.find((s) => s.key === status);
    if (!matchedStatus) return { success: false };

    const statusKey = fieldName.replace("isSms", "").replace("isSMS", "").replace("Enable", "");
    const userTemplate = setting[`sms${statusKey}Template`];
    const templateToUse = userTemplate || matchedStatus.template;

    const tracking_link = `https://www.shiproxx.com/track/${awb_number}`;
    const messageBody = templateToUse
      .replace(/{tracking_link}/g, tracking_link)
      .replace(/{order_id}/g, awb_number)
      .replace(/{customer_name}/g, "Customer");

    // Sanitize phone number: strip country code (+91 or 91) and any spaces/dashes
    // to get a clean 10-digit number - required by YourBulkSMS
    const rawNumber = String(mobile_number || "").replace(/\D/g, ""); // strip all non-digits
    const cleanNumber = rawNumber.length > 10 ? rawNumber.slice(-10) : rawNumber;

    if (cleanNumber.length !== 10) {
      console.error(`❌ Invalid phone number for SMS: '${mobile_number}' → cleaned to '${cleanNumber}'`);
      return { success: false };
    }

    console.log(`📱 Sending SMS to: ${cleanNumber}, Status: ${status}`);

    const response = await axios.get("http://control.yourbulksms.com/api/sendhttp.php?", {
      params: {
        authkey: "3632686970657834343532",
        mobiles: cleanNumber,
        message: `${messageBody} IBITTS`,
        sender: "IBITTS",
        route: "2",
        country: "0",
        DLT_TE_ID: "1707168499016611106",
      },
    });
    console.log("📨 SMS API Response:", response.data);
    console.log("sms response", response.data)
    if (response.data.Status === "Success") {
      // 🔹 Debit logic: Deduct 1 credit
      const User = require("../models/User.model");
      const userWithWallet = await User.findById(userId).select("Wallet");
      if (userWithWallet?.Wallet) {
        const Wallet = require("../models/wallet");
        const wallet = await Wallet.findById(userWithWallet.Wallet).select("creditBalance notificationTransactions");
        if (wallet) {
          wallet.creditBalance = Math.max(0, wallet.creditBalance - 1);
          wallet.notificationTransactions.push({
            channelOrderId: logEntry.awb_number || logEntry.orderId?.toString(),
            category: "debit",
            amount: 1,
            description: `Call Debit - NDR Follow-up (${logEntry.awb_number || logEntry.orderDisplayId})`,
            balanceAfterTransaction: wallet.creditBalance,
            date: new Date(),
          });
          await wallet.save();
        }
      }

      // 🔹 Update MessageLog
      await MessageLog.updateOne(
        { awb_number, status },
        { $set: { isSMSSent: true, userId } },
        { upsert: true }
      );

      return { success: true };
    }

    return { success: false };
  } catch (error) {
    console.error("❌ Error sending SMS:", error.message);
    return { success: false };
  }
};

const updateAdminNotificationForAllUsers = async (field, value) => {
  try {
    if (!field || typeof value !== "boolean") {
      throw new Error("Invalid field or boolean value");
    }

    // field examples: 'isAdminWhatsAppEnable', 'isAdminSMSEnable', 'isAdminEmailEnable'
    await NotificationSetting.updateMany({}, { $set: { [field]: value } });

    console.log(`✅ Successfully updated ${field} to ${value} for all users.`);
    return { success: true, message: `Successfully updated ${field} for all users.` };
  } catch (error) {
    console.error("❌ Error updating admin settings universally:", error.message);
    return { success: false, error: error.message };
  }
};


module.exports = {
  getNotificationSettings,
  updateNotificationSetting,
  buyCredits,
  getCreditBalance,
  getUserPassbookTransactions,
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
  updateAdminNotificationForAllUsers,
};
