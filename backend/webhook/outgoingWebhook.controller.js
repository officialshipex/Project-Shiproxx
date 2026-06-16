const Webhook = require("../models/Webhook.model");
const WebhookLog = require("../models/WebhookLog.model");
const crypto = require("crypto");
const axios = require("axios");

// Helper to generate a random Webhook ID
const generateWebhookId = () => {
  return "wh_" + crypto.randomBytes(4).toString("hex");
};

// Create a new webhook
const createWebhook = async (req, res) => {
  try {
    const { url, secret, topics, alertEmail } = req.body;
    const userId = req.user?._id || req.employee?._id;

    if (!url || !secret || !topics || topics.length === 0) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const newWebhook = new Webhook({
      userId,
      webhookId: generateWebhookId(),
      url,
      secret,
      topics,
      alertEmail,
    });

    await newWebhook.save();
    res.status(201).json({ success: true, webhook: newWebhook });
  } catch (error) {
    console.error("Error creating webhook:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Get all webhooks for a user
const getWebhooks = async (req, res) => {
  try {
    const userId = req.user?._id || req.employee?._id;
    const webhooks = await Webhook.find({ userId }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, webhooks });
  } catch (error) {
    console.error("Error fetching webhooks:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Update a webhook
const updateWebhook = async (req, res) => {
  try {
    const { id } = req.params;
    const { url, secret, topics, alertEmail, isActive } = req.body;
    const userId = req.user?._id || req.employee?._id;

    const webhook = await Webhook.findOneAndUpdate(
      { _id: id, userId },
      { url, secret, topics, alertEmail, isActive },
      { new: true }
    );

    if (!webhook) {
      return res.status(404).json({ success: false, message: "Webhook not found" });
    }

    res.status(200).json({ success: true, webhook });
  } catch (error) {
    console.error("Error updating webhook:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Delete a webhook
const deleteWebhook = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.employee?._id;

    const webhook = await Webhook.findOneAndDelete({ _id: id, userId });

    if (!webhook) {
      return res.status(404).json({ success: false, message: "Webhook not found" });
    }

    res.status(200).json({ success: true, message: "Webhook deleted successfully" });
  } catch (error) {
    console.error("Error deleting webhook:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Get webhook logs
const getWebhookLogs = async (req, res) => {
  try {
    const userId = req.user?._id || req.employee?._id;
    const { page = 1, limit = 10, topic, status, startDate, endDate } = req.query;

    const query = { userId };
    if (topic) query.eventTopic = topic;
    if (status) query.status = status;
    if (startDate && endDate) {
      query.timestamp = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const logs = await WebhookLog.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await WebhookLog.countDocuments(query);

    res.status(200).json({
      success: true,
      logs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching webhook logs:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Get log by ID
const getWebhookLogById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.employee?._id;

    const log = await WebhookLog.findOne({ _id: id, userId });

    if (!log) {
      return res.status(404).json({ success: false, message: "Log not found" });
    }

    res.status(200).json({ success: true, log });
  } catch (error) {
    console.error("Error fetching log detail:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Test a webhook — fires a demo track_update payload to verify connectivity
const testWebhook = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.employee?._id;

    const webhook = await Webhook.findOne({ _id: id, userId }).lean();
    if (!webhook) {
      return res.status(404).json({ success: false, message: "Webhook not found" });
    }

    // Build a realistic demo payload
    const demoPayload = {
      event: "track_update",
      timestamp: new Date().toISOString(),
      test: true,
      data: {
        orderId: 99999999,
        channelId: null,
        awb_number: "TEST_AWB_123456",
        courierServiceName: "Delhivery Surface",
        status: "In Transit",
        latestTracking: {
          status: "In Transit",
          StatusLocation: "Delhi Hub",
          StatusDateTime: new Date().toISOString(),
          Instructions: "Shipment is in transit to destination",
        },
        trackingHistory: [
          {
            status: "Booked",
            StatusLocation: "Mumbai",
            StatusDateTime: new Date(Date.now() - 86400000).toISOString(),
            Instructions: "Order booked successfully",
          },
          {
            status: "In Transit",
            StatusLocation: "Delhi Hub",
            StatusDateTime: new Date().toISOString(),
            Instructions: "Shipment is in transit to destination",
          },
        ],
      },
    };

    const payloadString = JSON.stringify(demoPayload);

    // Sign with HMAC-SHA256
    const signature = crypto
      .createHmac("sha256", webhook.secret)
      .update(payloadString)
      .digest("hex");

    const startTime = Date.now();
    let httpStatus = null;
    let responseBody = null;
    let deliveryStatus = "Failure";

    try {
      const response = await axios.post(webhook.url, demoPayload, {
        headers: {
          "Content-Type": "application/json",
          "x-shiproxx-signature": signature,
          "x-shiproxx-event": "track_update",
          "x-shiproxx-webhook-id": webhook.webhookId,
          "x-shiproxx-test": "true",
        },
        timeout: 10000,
      });

      httpStatus = response.status;
      responseBody = response.data;
      if (httpStatus >= 200 && httpStatus < 300) deliveryStatus = "Success";
    } catch (err) {
      httpStatus = err.response?.status || null;
      responseBody = err.response?.data || { error: err.message };
    }

    const responseTime = Date.now() - startTime;

    // Log the test delivery
    await WebhookLog.create({
      userId: webhook.userId,
      webhookId: webhook.webhookId,
      url: webhook.url,
      eventTopic: "track_update",
      httpStatus,
      status: deliveryStatus,
      payload: demoPayload,
      response: responseBody,
      responseTime,
      timestamp: new Date(),
    });

    return res.status(200).json({
      success: true,
      delivered: deliveryStatus === "Success",
      httpStatus,
      responseTime,
      response: responseBody,
    });
  } catch (error) {
    console.error("Error testing webhook:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = {
  createWebhook,
  getWebhooks,
  updateWebhook,
  deleteWebhook,
  getWebhookLogs,
  getWebhookLogById,
  testWebhook,
};
