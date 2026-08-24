const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const User = require("../models/User.model");
const WalletTransaction = require("../models/WalletTransaction.model");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");

/**
 * Shadowfax Webhook Controller
 * Handles real-time push notifications from Shadowfax Unified API.
 */
const ShadowfaxWebhook = async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];
    const secureToken = process.env.SHADOWFAX_WEBHOOK_TOKEN;

    if (secureToken) {
      const providedToken = authHeader?.startsWith("Token ") ? authHeader.split(" ")[1] : authHeader;
      if (providedToken !== secureToken) {
        console.warn("Shadowfax Webhook: Unauthorized access attempt.");
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
    }

    const body = req.body;
    console.log("Shadowfax Webhook Received:", JSON.stringify(body, null, 2));

    // Shadowfax usually sends a single object, but we wrap it to be safe
    const events = Array.isArray(body) ? body : [body];

    for (const event of events) {
      const awb = event.awb_number;
      const sfxStatusId = event.status_id?.toLowerCase() || "";
      const statusDescription = event.status || "";
      const remarks = event.remarks || statusDescription || "No remarks";
      const location = event.location || "Unknown";
      const timestamp = event.created ? new Date(event.created) : new Date();

      if (!awb) {
        console.warn("Shadowfax Webhook: Missing awb_number, skipping event.");
        continue;
      }

      // Fetch order by AWB
      const order = await Order.findOne({ awb_number: String(awb) });

      if (!order) {
        console.warn(`Shadowfax Webhook: Order not found for AWB ${awb}`);
        continue;
      }

      // Skip processed/cancelled orders if appropriate
      if (order.status === "Cancelled" && sfxStatusId !== "cancelled_by_seller") {
         console.log(`Shadowfax Webhook: Skipping AWB ${awb} because order is already Cancelled.`);
         continue;
      }

      const oldStatus = order.status; // kept for logging

      // ── Duplicate Tracking Check ──
      const lastTracking = order.tracking[order.tracking.length - 1];
      if (
        lastTracking &&
        lastTracking.Instructions === sfxStatusId &&
        lastTracking.StatusLocation === location &&
        new Date(lastTracking.StatusDateTime).getTime() === timestamp.getTime()
      ) {
        console.log(`Shadowfax Webhook: Duplicate tracking for AWB ${awb}, skipping.`);
        continue;
      }

      let balanceTobeAdded = 0;
      let shouldUpdateWallet = false;

      // ── Shadowfax Status Mapping (Consistent with tracking.controller.js) ──

      // ── Forward journey ──
      if (sfxStatusId === "new" || sfxStatusId === "assigned_for_seller_pickup") {
        order.status = "Booked";
      }

      if (
        sfxStatusId === "ofp" ||
        sfxStatusId === "picked" ||
        sfxStatusId === "recd_at_rev_hub" ||
        sfxStatusId === "item_manifested" ||
        sfxStatusId === "received_from_client_warehouse"
      ) {
        order.status = "Ready To Ship";
      }

      if (
        sfxStatusId === "recd_at_fwd_hub" ||
        sfxStatusId === "recd_at_fwd_dc" ||
        sfxStatusId === "bag_in_transit" ||
        sfxStatusId === "bag_received" ||
        sfxStatusId === "bag_received_at_via" ||
        sfxStatusId === "in_transit" ||
        sfxStatusId === "assigned_for_delivery"
      ) {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
        if (!order.invoiceDate) {
          order.invoiceDate = timestamp;
        }
      }

      if (sfxStatusId === "ofd") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
      }

      if (sfxStatusId === "delivered") {
        order.status = "Delivered";
        order.reattempt = false;
        if (
          ["Undelivered", "Out for Delivery", "Action_Requested"].includes(order.ndrStatus)
        ) {
          order.ndrStatus = "Delivered";
        }
      }

      // ── NDR cases ──
      if (["nc", "na", "cid"].includes(sfxStatusId)) {
        if (order.ndrStatus !== "Action_Requested") {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          order.ndrReason = {
            date: timestamp,
            reason: statusDescription || sfxStatusId,
          };

          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
          const lastEntryDate = lastAction?.date ? new Date(lastAction.date).getTime() : null;
          const currentStatusDate = timestamp.getTime();

          if (order.ndrHistory.length === 0 || !lastEntryDate || currentStatusDate > lastEntryDate) {
            const attemptCount = order.ndrHistory.length + 1;
            order.reattempt = true;
            order.ndrHistory.push({
              actions: [
                {
                  action: `NDR ${attemptCount} Raised`,
                  actionBy: "Shadowfax",
                  remark: statusDescription || sfxStatusId,
                  source: "Shadowfax",
                  date: timestamp,
                },
              ],
            });
          }
        }
      }

      if (order.ndrHistory.length >= 4) {
        order.reattempt = false;
      }

      if (sfxStatusId === "reopen_ndr") {
        order.reattempt = true;
      }

      // ── RTO / RTS ──
      if (["ots", "rts", "oto", "cancelled_by_customer", "seller_not_contactable"].includes(sfxStatusId)) {
        order.status = "RTO";
        order.ndrStatus = "RTO";
        order.reattempt = false;
      }

      if (
        ["rts_in_process", "in_transit_return", "oto_in_process", "rto_in_process", "rts_ofd", "rto_ofd"].includes(sfxStatusId)
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      if (["rts_d", "rto_d"].includes(sfxStatusId)) {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
      }

      // ── Lost ──
      if (sfxStatusId === "lost") {
        order.status = "Lost";
        order.reattempt = false;
      }

      // ── Cancelled & Refund ──
      if (sfxStatusId === "cancelled_by_seller") {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        order.reattempt = false;

        balanceTobeAdded =
          !order.totalFreightCharges || order.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(order.totalFreightCharges);
        shouldUpdateWallet = true;
      }

      // ── Process Wallet Refund ──
      if (shouldUpdateWallet && balanceTobeAdded > 0 && !order.walletRefunded) {
        const userDoc = await User.findById(order.userId);
        if (userDoc) {
          const currentWallet = await Wallet.findById(userDoc.Wallet).select("balance");
          if (currentWallet) {
             // Check if already refunded
             const alreadyRefunded = await WalletTransaction.exists({
                walletId: currentWallet._id,
                awb_number: order.awb_number,
                category: "credit",
                description: "Freight Charges Received"
             });

             if (!alreadyRefunded) {
                const newBalance = (currentWallet.balance || 0) + balanceTobeAdded;
                 await Wallet.findOneAndUpdate(
                    { _id: currentWallet._id },
                    {
                       $inc: { balance: balanceTobeAdded },
                    }
                 );

                await WalletTransaction.create({
                   walletId: currentWallet._id,
                   channelOrderId: order.orderId || null,
                   category: "credit",
                   amount: balanceTobeAdded,
                   balanceAfterTransaction: newBalance,
                   date: new Date(),
                   awb_number: order.awb_number,
                   description: "Freight Charges Received",
                }).catch(err => console.error("⚠️ WalletTransaction dual-write failed for ShadowfaxWebhook:", err.message));

                order.walletRefunded = true;
                console.log(`Shadowfax Webhook: Refunded ₹${balanceTobeAdded} for AWB ${order.awb_number}`);
             }
          }
        }
      }

      // ── Save Tracking Entry ──
      order.tracking.push({
        Instructions: sfxStatusId,
        Status: statusDescription,
        StatusDateTime: timestamp,
        StatusLocation: location,
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

      console.log(`Shadowfax Webhook: AWB ${awb} updated → status=${order.status}`);
    }

    return res.status(200).json({ success: true, message: "Webhook processed" });
  } catch (error) {
    console.error("Shadowfax Webhook Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { ShadowfaxWebhook };
