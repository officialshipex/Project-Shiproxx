/**
 * dispatchTrackWebhook.js
 *
 * Fires a `track_update` webhook event whenever a tracking entry is pushed
 * to an order. Finds all active webhooks configured by the order's owner,
 * signs the payload with HMAC-SHA256, dispatches the HTTP POST, and writes
 * a WebhookLog entry for every attempt.
 */

const crypto = require("crypto");
const axios = require("axios");

/**
 * Main dispatcher — call this fire-and-forget style.
 * @param {Object} order  - The full order document (plain object or Mongoose doc)
 * @param {Object} latestTracking - The new tracking entry that was just added
 */
const dispatchTrackWebhook = async (order, latestTracking) => {
  // Lazy-require models to avoid circular dependency issues at startup
  const Webhook = require("../models/Webhook.model");
  const WebhookLog = require("../models/WebhookLog.model");

  if (!order || !order.userId) return;

  try {
    // 1. Find all active webhooks for this user that include the track_update topic
    const webhooks = await Webhook.find({
      userId: order.userId,
      isActive: true,
      topics: "track_update",
    }).lean();

    if (!webhooks || webhooks.length === 0) return;

    // 2. Build the canonical payload
    const payload = {
      event: "track_update",
      timestamp: new Date().toISOString(),
      data: {
        orderId: order.orderId,
        channelId: order.channelId || null,
        awb_number: order.awb_number || null,
        courierServiceName: order.courierServiceName || null,
        status: order.status,
        latestTracking: latestTracking || null,
        // Include last 5 tracking events for context
        trackingHistory: Array.isArray(order.tracking)
          ? order.tracking.slice(-5)
          : [],
      },
    };

    const payloadString = JSON.stringify(payload);

    // 3. Dispatch to every configured webhook (in parallel)
    const dispatches = webhooks.map((wh) =>
      _sendWebhook(wh, payload, payloadString, WebhookLog)
    );

    // Fire and forget — don't await, don't block the caller
    Promise.allSettled(dispatches).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(
            `[Webhook] Dispatch failed for ${webhooks[i]?.webhookId}:`,
            r.reason?.message || r.reason
          );
        }
      });
    });
  } catch (err) {
    // Never crash the caller — silently log
    console.error("[Webhook] dispatchTrackWebhook error:", err.message);
  }
};

/**
 * Internal helper: sign + send one webhook, write log.
 */
const _sendWebhook = async (wh, payload, payloadString, WebhookLog) => {
  const startTime = Date.now();
  let httpStatus = null;
  let responseBody = null;
  let deliveryStatus = "Failure";

  // HMAC-SHA256 signature
  const signature = crypto
    .createHmac("sha256", wh.secret)
    .update(payloadString)
    .digest("hex");

  try {
    const response = await axios.post(wh.url, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-shiproxx-signature": signature,
        "x-shiproxx-event": "track_update",
        "x-shiproxx-webhook-id": wh.webhookId,
      },
      timeout: 10000, // 10s timeout
    });

    httpStatus = response.status;
    responseBody = response.data;

    // Consider 2xx as success
    if (httpStatus >= 200 && httpStatus < 300) {
      deliveryStatus = "Success";
      console.log(
        `[Webhook] ✅ Delivered to ${wh.webhookId} → ${wh.url} (${httpStatus})`
      );
    } else {
      console.warn(
        `[Webhook] ⚠️ Non-2xx from ${wh.webhookId} → ${wh.url} (${httpStatus})`
      );
    }
  } catch (err) {
    httpStatus = err.response?.status || null;
    responseBody = err.response?.data || { error: err.message };
    console.error(
      `[Webhook] ❌ Failed for ${wh.webhookId} → ${wh.url}:`,
      err.message
    );
  }

  const responseTime = Date.now() - startTime;

  // Write log regardless of success/failure
  try {
    await WebhookLog.create({
      userId: wh.userId,
      webhookId: wh.webhookId,
      url: wh.url,
      eventTopic: "track_update",
      httpStatus,
      status: deliveryStatus,
      payload,
      response: responseBody,
      responseTime,
      timestamp: new Date(),
    });
  } catch (logErr) {
    console.error("[Webhook] Failed to write log:", logErr.message);
  }
};

module.exports = { dispatchTrackWebhook };
