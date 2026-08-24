const Order = require("../models/newOrder.model");
const AMAZON_SHIPPING_WEBHOOK_TOKEN = process.env.AMAZON_SHIPPING_WEBHOOK_TOKEN;
const {
  updateNdrHistoryByAwb,
  formatAmazonDate,
} = require("../Orders/tracking.controller");

const AmazonShippingWebhook = async (req, res) => {
  try {
    const token = req.headers.authorization;
    console.log("Amazon Webhook Token:", token);

    if (token !== AMAZON_SHIPPING_WEBHOOK_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    console.log("Amazon Webhook Payload Received:", req.body);

    const detail = req.body?.detail;
    if (!detail) return res.status(400).send("Invalid payload");

    const trackingId = detail.trackingId || detail.alternateLegTrackingId;
    if (!trackingId) return res.status(400).send("Missing tracking ID");

    const order = await Order.findOne({ awb_number: trackingId });
    if (!order) return res.status(404).send("Order not found");

    if (["new", "Cancelled"].includes(order.status)) {
      console.log(
        `Skipping Amazon Webhook for AWB ${trackingId} because order status is "${order.status}"`
      );
      return res.status(200).send("Ignored (Order Not Yet Shipped)");
    }

    const eventCode = detail.eventCode; // e.g. ReadyForReceive
    const eventTime = formatAmazonDate(detail.eventTime);
    const shipmentType = detail.shipmentType; // FORWARD / RETURNS

    // ---------------------------
    // FORWARD FLOW
    // ---------------------------
    if (shipmentType === "FORWARD") {
      if (eventCode === "ReadyForReceive") {
        order.status = "Ready To Ship";
        order.reattempt = false;
      }

      if (
        eventCode === "PickupDone" ||
        eventCode === "ArrivedAtCarrierFacility" ||
        eventCode === "Departed" ||
        eventCode === "InTransit"
      ) {
        order.status = "In-transit";
        order.reattempt = false;
      }

      if (eventCode === "OutForDelivery") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
      }

      if (eventCode === "Delivered") {
        order.status = "Delivered";

        // If NDR existed → NDR Delivered
        if (order.ndrHistory && order.ndrHistory.length > 0) {
          order.ndrStatus = "Delivered";
        } else {
          order.ndrStatus = null;
        }

        order.reattempt = false;
      }

      // NDR / Failed Delivery
      if (eventCode === "Rejected" || eventCode === "Undeliverable") {
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";

        const newDate = new Date(eventTime);

        const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
        const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
        const lastDate = lastAction ? new Date(lastAction.date) : null;

        const canAddNewEntry =
          !lastDate || newDate.getTime() > lastDate.getTime();
        if (canAddNewEntry) {
          const attempt = order.ndrHistory.length + 1;
          order.ndrHistory.push({
            actions: [
              {
                action: `NDR ${attempt} Raised`,
                actionBy: order.provider,
                remark: eventCode,
                source: order.provider,
                date: eventTime,
              },
            ],
          });
          order.reattempt = true;

          order.ndrReason = {
            date: eventTime,
            reason: eventCode,
          };
        }
      }
    }

    // ---------------------------
    // RETURNS / RTO FLOW
    // ---------------------------
    if (shipmentType === "RETURNS") {
      if (eventCode === "ReturnInitiated") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      if (
        eventCode === "ArrivedAtCarrierFacility" ||
        eventCode === "Departed"
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      if (eventCode === "Delivered") {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
      }

      if (eventCode === "Undeliverable") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }
    }

    // ---------------------------
    // TRACKING PUSH
    // ---------------------------
    order.tracking.push({
      status: order.status,
      Instructions: eventCode,
      StatusDateTime: eventTime,
      StatusLocation: detail.location
        ? formatAmazonLocation(detail.location)
        : "",
    });

    await order.save();

    // 🔔 Trigger Notifications are now handled automatically by the Order model hook (post-save)
    // Sync to WooCommerce if applicable
    if (order.channel === "WooCommerce") {
      (async () => {
        try {
          const AllChannelModel = require("../Channels/allChannel.model");
          const { markWooOrderAsShipped } = require("../Channels/WooCommerce/woocommerce.controller");
          const store = await AllChannelModel.findOne({ userId: order.userId, channel: "WooCommerce" });
          if (store?.storeURL) {
            await markWooOrderAsShipped(store.storeURL, order.orderId, order.awb_number, order.provider, order.status);
          }
        } catch (e) {
          console.error(`⚠️ WooCommerce sync failed for AWB ${order.awb_number}:`, e.message);
        }
      })();
    }

    // Sync to Shopify if applicable
    if (order.channel === "Shopify") {
      (async () => {
        try {
          const AllChannelModel = require("../Channels/allChannel.model");
          const { markShopifyOrderAsShipped } = require("../Channels/allChannel.controller");
          const store = await AllChannelModel.findOne({ userId: order.userId, channel: "Shopify" });
          if (store?.storeURL) {
            await markShopifyOrderAsShipped(store.storeURL, order.orderId, order.awb_number, order.provider, order.status);
          }
        } catch (e) {
          console.error(`⚠️ Shopify sync failed for AWB ${order.awb_number}:`, e.message);
        }
      })();
    }

    return res.status(200).send("Webhook processed successfully");
  } catch (error) {
    console.error("Amazon Webhook Error:", error);
    return res.status(500).send("Internal Server Error");
  }
};

function formatAmazonLocation(location = {}) {
  const { city, stateOrRegion, postalCode, countryCode } = location;

  return [city, stateOrRegion, postalCode, countryCode]
    .filter(Boolean)
    .join(", ");
}

module.exports = { AmazonShippingWebhook };
