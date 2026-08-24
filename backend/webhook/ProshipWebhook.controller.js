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
 * Proship Status Code Mapping:
 * 1  - ORDER_PLACED
 * 2  - PICKUP_PENDING
 * 3  - PICKUP_FAILED
 * 4  - PICKED_UP
 * 5  - INTRANSIT
 * 6  - OUT_FOR_DELIVERY
 * 7  - NOT_SERVICEABLE
 * 8  - DELIVERED
 * 9  - FAILED_DELIVERY (NDR)
 * 10 - CANCELLED_ORDER
 * 11 - RTO_REQUESTED
 * 12 - RTO
 * 13 - RTO_OUT_FOR_DELIVERY
 * 14 - RTO_DELIVERED
 * 15 - RTO_FAILED
 * 16 - LOST
 * 17 - DAMAGED
 * 18 - SHIPMENT_DELAYED
 * 19 - CONTACT_CUSTOMER_CARE
 * 20 - SHIPMENT_HELD
 * 21 - RTO_INTRANSIT
 * 25 - OUT_FOR_PICKUP
 * 26 - RTO_CONTACT_CUSTOMER_CARE
 * 27 - RTO_SHIPMENT_DELAY
 * 28 - AWB_REGISTERED
 * 33 - MANIFESTED
 * 101- RETURN_ORDER_PLACED
 */

const RTO_STATUS_CODES = [11, 12, 13, 14, 15, 21, 26, 27, 101];

const ProshipWebhook = async (req, res) => {
  try {
    const body = req.body;
    console.log("Proship Webhook Received:", JSON.stringify(body, null, 2));

    // Proship sends individual shipment event (not wrapped in array)
    // Support both array and single object payloads
    const events = Array.isArray(body) ? body : [body];

    for (const event of events) {
      const awb = event.waybill;
      const statusCode = event.orderStatusCode;
      const location = event.currentLocation || "Unknown";
      // Proship timestamps are UTC — shift to IST (+5h30m) before storing
      const toIST = (utcStr) => {
        if (!utcStr) return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
        const d = new Date(utcStr);
        d.setTime(d.getTime() + 5.5 * 60 * 60 * 1000);
        return d;
      };
      const timestamp = toIST(event.timestamp);

      // Remove the word "proship" from anywhere in the text (case-insensitive)
      const cleanProshipText = (str) => {
        if (!str) return str;
        return str
          .replace(/\s*[-\u2013]\s*proship/gi, "")  // " - proship"
          .replace(/proship\s*[-\u2013]\s*/gi, "")  // "proship - "
          .replace(/\bon\s+proship\b/gi, "")         // "on proship"
          .replace(/\bproship\b/gi, "")              // any remaining word
          .replace(/\s{2,}/g, " ")                   // collapse extra spaces
          .replace(/[\s\-\u2013]+$/, "")             // trailing separators
          .trim();
      };

      const statusDescription = cleanProshipText(event.orderStatusDescription || "");
      const remark = cleanProshipText(event.remark || event.orderStatusDescription || "");

      if (!awb) {
        console.warn("Proship Webhook: Missing waybill, skipping event.");
        continue;
      }

      if (statusCode === undefined || statusCode === null) {
        console.warn(`Proship Webhook: Missing orderStatusCode for AWB ${awb}, skipping.`);
        continue;
      }

      // Fetch order by AWB
      const order = await Order.findOne({ awb_number: String(awb) });

      if (!order) {
        console.warn(`Proship Webhook: Order not found for AWB ${awb}`);
        continue;
      }

      if (["new", "Cancelled"].includes(order.status)) {
        console.log(
          `Proship Webhook: Skipping AWB ${awb} because order status is "${order.status}"`
        );
        continue;
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
        console.log(`Proship Webhook: Duplicate tracking for AWB ${awb}, skipping.`);
        continue;
      }

      const isRTO = RTO_STATUS_CODES.includes(statusCode);

      /* ================================================================
         RTO FLOW
      ================================================================ */
      if (isRTO) {
        order.reattempt = false;

        if (statusCode === 11 || statusCode === 101) {
          // RTO_REQUESTED / RETURN_ORDER_PLACED
          order.status = "RTO";
          order.ndrStatus = "RTO";
        }

        if (statusCode === 12) {
          // RTO
          order.status = "RTO";
          order.ndrStatus = "RTO";
        }

        if (statusCode === 21) {
          // RTO_INTRANSIT
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
        }

        if (statusCode === 13) {
          // RTO_OUT_FOR_DELIVERY
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
        }

        if (statusCode === 14) {
          // RTO_DELIVERED
          order.status = "RTO Delivered";
          order.ndrStatus = "RTO Delivered";
        }

        if (statusCode === 15) {
          // RTO_FAILED
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO Failed";
        }

        if (statusCode === 26 || statusCode === 27) {
          // RTO_CONTACT_CUSTOMER_CARE / RTO_SHIPMENT_DELAY
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
        }
      } else {
        /* ================================================================
           FORWARD FLOW
        ================================================================ */

        if (statusCode === 1 || statusCode === 28 || statusCode === 33) {
          // ORDER_PLACED / AWB_REGISTERED / MANIFESTED
          order.status = "Booked";
        }

        if (statusCode === 2 || statusCode === 25) {
          // PICKUP_PENDING / OUT_FOR_PICKUP
          order.status = "Ready To Ship";
        }

        if (statusCode === 3) {
          // PICKUP_FAILED
          order.status = "Not Picked";
        }

        if (statusCode === 4) {
          // PICKED_UP
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
          order.reattempt = false;
          if (!order.invoiceDate) {
            order.invoiceDate = timestamp;
          }
        }

        if (statusCode === 5 || statusCode === 18 || statusCode === 20) {
          // INTRANSIT / SHIPMENT_DELAYED / SHIPMENT_HELD
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
          order.reattempt = false;
        }

        if (statusCode === 6) {
          // OUT_FOR_DELIVERY
          order.status = "Out for Delivery";
          order.ndrStatus = "Out for Delivery";
          order.reattempt = false;
        }

        if (statusCode === 7) {
          // NOT_SERVICEABLE
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
        }

        /* ── DELIVERED ── */
        if (statusCode === 8) {
          order.status = "Delivered";
          if (order.ndrHistory.length > 0) {
            order.ndrStatus = "Delivered";
            order.reattempt = true;
          } else {
            order.ndrStatus = "";
            order.reattempt = false;
          }
        }

        /* ── CANCELLED ── */
        if (statusCode === 10) {
          order.status = "Cancelled";
          order.ndrStatus = "Cancelled";

          const balanceToBeAdded =
            !order.totalFreightCharges || order.totalFreightCharges === "N/A"
              ? 0
              : parseFloat(order.totalFreightCharges);

          if (balanceToBeAdded > 0 && !order.walletRefunded) {
            const userDoc = await User.findById(order.userId);
            if (userDoc) {
              const currentWallet = await Wallet.findById(userDoc.Wallet).select("balance");
              if (currentWallet) {
                const alreadyRefunded = await WalletTransaction.exists({
                  walletId: currentWallet._id,
                  awb_number: order.awb_number,
                  category: "credit",
                  description: "Freight Charges Received"
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
                  }).catch(err => console.error("⚠️ WalletTransaction dual-write failed for ProshipWebhook:", err.message));

                  order.walletRefunded = true;
                  console.log(
                    `Proship Webhook: Refunded ₹${balanceToBeAdded} for AWB ${order.awb_number} due to cancellation`
                  );
                }
              }
            }
          }
        }

        /* ── LOST / DAMAGED ── */
        if (statusCode === 16) order.status = "Lost";
        if (statusCode === 17) order.status = "In-transit"; // Damaged – keep in transit

        /* ── CONTACT CUSTOMER CARE ── */
        if (statusCode === 19) {
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
        }

        /* ── FAILED DELIVERY (NDR) ── */
        if (statusCode === 9) {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";

          const currentDate = new Date(timestamp).getTime();

          let lastNdrDate = null;
          if (order.ndrHistory.length > 0) {
            const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
            const lastAction = lastHistory.actions[lastHistory.actions.length - 1];
            lastNdrDate = new Date(lastAction.date).getTime();
          }

          const attemptCount = order.ndrHistory.length + 1;

          order.ndrReason = {
            date: timestamp,
            reason: remark,
          };

          // Block duplicate / older NDR updates
          if (
            order.ndrStatus === "Action_Requested" &&
            lastNdrDate &&
            currentDate <= lastNdrDate
          ) {
            console.log(`Proship Webhook: Duplicate/older NDR for AWB ${awb}, skipping NDR push.`);
            // We just fall through to the end of the loop where save/notify happens anyway
          } else if (!lastNdrDate || currentDate > lastNdrDate) {
            // Valid new NDR
            order.reattempt = true;
            order.ndrHistory.push({
              actions: [
                {
                  action: `NDR ${attemptCount} Raised`,
                  actionBy: order.provider || "Shadowfax",
                  remark: remark,
                  source: order.provider || "Shadowfax",
                  date: timestamp,
                },
              ],
            });
          }
        }
      }

      /* ================================================================
         SAVE TRACKING ENTRY
      ================================================================ */
      // Avoid pushing to tracking array twice if we already handled it above (though we didn't in this refactor)
      order.tracking.push({
        Instructions: remark,
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
      
      console.log(`Proship Webhook: AWB ${awb} updated → status=${order.status}`);
    }

    return res.status(200).json({
      success: true,
      message: "Webhook processed successfully",
    });
  } catch (error) {
    console.error("Proship Webhook Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { ProshipWebhook };
