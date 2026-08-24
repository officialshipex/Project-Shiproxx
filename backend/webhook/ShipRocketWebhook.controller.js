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
 * Shiprocket Status ID Mapping (Provided by User):
 * 6  - Shipped
 * 7  - Delivered
 * 8  - Canceled
 * 9  - RTO Initiated
 * 10 - RTO Delivered
 * 12 - Lost
 * 13 - Pickup Error
 * 14 - RTO Acknowledged
 * 15 - Pickup Rescheduled
 * 16 - Cancellation Requested
 * 17 - Out For Delivery
 * 18 - In Transit
 * 19 - Out For Pickup
 * 20 - Pickup Exception
 * 21 - Undelivered
 * 22 - Delayed
 * 23 - Partial_Delivered
 * 24 - DESTROYED
 * 25 - DAMAGED
 * 26 - FULFILLED
 * 27 - Pickup Booked
 * 38 - REACHED AT DESTINATION HUB
 * 39 - MISROUTED
 * 40 - RTO_NDR
 * 41 - RTO_OFD
 * 42 - PICKED UP
 * 43 - SELF FULFILLED
 * 44 - DISPOSED OFF
 * 45 - CANCELLED_BEFORE_DISPATCHED
 * 46 - RTO IN INTRANSIT
 * 47 - QC FAILED
 * 48 - Reached Warehouse
 * 49 - Custom Cleared
 * 50 - In Flight
 * 51 - Handover to Courier
 * 52 - Shipment Booked
 * 54 - In Transit Overseas
 * 55 - Connection Aligned
 * 56 - Reached Overseas Warehouse
 * 57 - Custom Cleared Overseas
 * 59 - Box Packing
 * 60 - FC Allocated
 * 61 - Picklist Generated
 * 62 - Ready To Pack
 * 63 - Packed
 * 67 - FC MANIFEST GENERATED
 * 68 - PROCESSED AT WAREHOUSE
 * 71 - HANDOVER EXCEPTION
 * 72 - PACKED EXCEPTION
 * 75 - RTO_LOCK
 * 76 - UNTRACEABLE
 * 77 - ISSUE_RELATED_TO_THE_RECIPIENT
 * 78 - REACHED_BACK_AT_SELLER_CITY
 */

const ShipRocketWebhook = async (req, res) => {
  try {
    const webhookToken = req.headers["x-api-key"];
    const secureToken = process.env.SHIPROCKET_WEBHOOK_TOKEN;

    if (webhookToken !== secureToken) {
      console.warn("ShipRocket Webhook: Unauthorized access attempt.");
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const body = req.body;
    console.log("ShipRocket Webhook Received:", JSON.stringify(body, null, 2));

    const moment = require("moment");

    // Shiprocket sends individual shipment event
    const awb = body.awb;
    const statusId = parseInt(body.current_status_id || body.status_id);
    const statusText = body.current_status || body.status || "Unknown";
    const location = body.location || (body.scans && body.scans.length > 0 ? body.scans[body.scans.length - 1].location : "Unknown");
    
    // Parse date using moment to handle Shiprocket's format
    const rawTimestamp = body.current_timestamp || (body.scans && body.scans.length > 0 ? body.scans[body.scans.length - 1].date : null);
    const timestamp = rawTimestamp ? moment(rawTimestamp, ["DD-MM-YYYY HH:mm:ss", "YYYY-MM-DD HH:mm:ss", "DD MM YYYY HH:mm:ss"]).toDate() : new Date();
    
    // Extract remark/activity
    const remark = body.activity || (body.scans && body.scans.length > 0 ? body.scans[body.scans.length - 1].activity : statusText);

    if (!awb) {
      console.warn("ShipRocket Webhook: Missing AWB, skipping event.");
      return res.status(200).json({ success: false, message: "Missing AWB" });
    }

    // Fetch order by AWB
    const order = await Order.findOne({ awb_number: String(awb) });

    if (!order) {
      console.warn(`ShipRocket Webhook: Order not found for AWB ${awb}`);
      return res.status(200).json({ success: false, message: "Order not found" });
    }

    if (["new", "Cancelled"].includes(order.status) && statusId !== 10) {
      console.log(`ShipRocket Webhook: Skipping AWB ${awb} because order status is "${order.status}"`);
      return res.status(200).json({ success: true, message: "Order inactive" });
    }

    const oldStatus = order.status; // kept for logging

    // ── Duplicate Tracking Check ──
    const lastTracking = order.tracking[order.tracking.length - 1];
    if (
      lastTracking &&
      lastTracking.Instructions === remark &&
      lastTracking.StatusLocation === location &&
      new Date(lastTracking.StatusDateTime).getTime() === new Date(timestamp).getTime()
    ) {
      console.log(`ShipRocket Webhook: Duplicate tracking for AWB ${awb}, skipping.`);
      return res.status(200).json({ success: true, message: "Duplicate" });
    }

    /* ================================================================
       STATUS MAPPING
    ================================================================ */
    switch (statusId) {
      case 62: // Ready To Pack
      case 63: // Packed
      case 67: // FC MANIFEST GENERATED
        order.status = "Ready To Ship";
        break;

      case 15: // Pickup Rescheduled
      case 19: // Out For Pickup
      case 27: // Pickup Booked
      case 52: // Shipment Booked
      case 59: // Box Packing
      case 60: // FC Allocated
      case 61: // Picklist Generated
      case 72: // PACKED EXCEPTION
        order.status = "Booked";
        break;

      case 6:  // Shipped
      case 18: // In Transit
      case 22: // Delayed
      case 38: // REACHED AT DESTINATION HUB
      case 39: // MISROUTED
      case 42: // PICKED UP
      case 48: // Reached Warehouse
      case 49: // Custom Cleared
      case 50: // In Flight
      case 51: // Handover to Courier
      case 54: // In Transit Overseas
      case 55: // Connection Aligned
      case 56: // Reached Overseas Warehouse
      case 57: // Custom Cleared Overseas
      case 68: // PROCESSED AT WAREHOUSE
      case 71: // HANDOVER EXCEPTION
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
        if (!order.invoiceDate) order.invoiceDate = timestamp;
        break;

      case 17: // Out For Delivery
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
        break;

      case 7:  // Delivered
      case 23: // Partial_Delivered
      case 26: // FULFILLED
      case 43: // SELF FULFILLED
        order.status = "Delivered";
        if (order.ndrHistory.length > 0) {
          order.ndrStatus = "Delivered";
          order.reattempt = true;
        } else {
          order.ndrStatus = "";
          order.reattempt = false;
        }
        break;

      case 8:  // Canceled
      case 16: // Cancellation Requested
      case 45: // CANCELLED_BEFORE_DISPATCHED
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        // Handle Wallet Refund
        const balanceToBeAdded = !order.totalFreightCharges || order.totalFreightCharges === "N/A"
          ? 0 : parseFloat(order.totalFreightCharges);

        if (balanceToBeAdded > 0 && !order.walletRefunded) {
          const userDoc = await User.findById(order.userId);
          if (userDoc) {
            const currentWallet = await Wallet.findById(userDoc.Wallet).select("balance");
            if (currentWallet) {
              const alreadyRefunded = await WalletTransaction.exists({
                walletId: currentWallet._id,
                awb_number: order.awb_number,
                category: "credit",
                description: { $in: ["Freight Charges Received", "Freight Charges Refunded"] }
              });

              if (!alreadyRefunded) {
                const newBalance = (currentWallet.balance || 0) + balanceToBeAdded;
                await Wallet.findOneAndUpdate(
                  { _id: currentWallet._id },
                  {
                    $inc: { balance: balanceToBeAdded },
                  }
                );

                await WalletTransaction.create({
                  walletId: currentWallet._id,
                  channelOrderId: order.orderId || null,
                  category: "credit",
                  amount: balanceToBeAdded,
                  balanceAfterTransaction: newBalance,
                  date: new Date(),
                  awb_number: order.awb_number,
                  description: "Freight Charges Received",
                }).catch(err => console.error("⚠️ WalletTransaction dual-write failed for ShipRocketWebhook:", err.message));

                order.walletRefunded = true;
              }
            }
          }
        }
        break;

      case 9:  // RTO Initiated
      case 14: // RTO Acknowledged
      case 40: // RTO_NDR
      case 46: // RTO IN INTRANSIT
      case 75: // RTO_LOCK
      case 41: // RTO_OFD
        order.status = "RTO";
        order.ndrStatus = "RTO";
        order.reattempt = false;
        break;

      case 10: // RTO Delivered
      case 78: // REACHED_BACK_AT_SELLER_CITY
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
        break;

      case 12: // Lost
      case 76: // UNTRACEABLE
      case 24: // DESTROYED
      case 44: // DISPOSED OFF
      case 47: // QC FAILED
        order.status = "Lost";
        order.ndrStatus = "Lost";
        order.reattempt = false;
        break;

      case 25: // DAMAGED
        order.status = "Damaged";
        order.ndrStatus = "Damaged";
        order.reattempt = false;
        break;

      case 13: // Pickup Error
      case 20: // Pickup Exception
      case 21: // Undelivered
      case 77: // ISSUE_RELATED_TO_THE_RECIPIENT
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";
        order.reattempt = true;

        const attemptCount = order.ndrHistory.length + 1;
        order.ndrReason = { date: timestamp, reason: remark };

        // Push to NDR history if not duplicate
        const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
        const lastActionDate = lastNdr?.actions[lastNdr.actions.length - 1]?.date;

        if (!lastActionDate || new Date(timestamp).getTime() > new Date(lastActionDate).getTime()) {
          order.ndrHistory.push({
            actions: [
              {
                action: `NDR ${attemptCount} Raised`,
                actionBy: order.provider,
                remark: remark,
                source: order.provider,
                date: timestamp,
              },
            ],
          });
        }
        break;

      default:
        // Keep current status if unknown
        break;
    }

    /* ================================================================
       SAVE TRACKING ENTRY
    ================================================================ */
    order.tracking.push({
      Instructions: remark,
      Status: statusText,
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

    return res.status(200).json({ success: true, message: "Webhook processed successfully" });
  } catch (error) {
    console.error("ShipRocket Webhook Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { ShipRocketWebhook };
