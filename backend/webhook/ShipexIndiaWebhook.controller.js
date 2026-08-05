const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const User = require("../models/User.model");
const WalletTransaction = require("../models/WalletTransaction.model");

const ShipexIndiaWebhook = async (req, res) => {
  try {
    const body = req.body;
    console.log("ShipexIndia Webhook Received:", JSON.stringify(body, null, 2));

    // Support multiple formats: direct fields, nested under "data", or nested under "data.latestTracking"
    const data = body.data || {};
    const latest = data.latestTracking || {};

    const awb = data.awb_number || data.awb || body.awb_number || body.awb || latest.awb_number || latest.awb;
    const statusText = data.status || body.status || latest.status || body.event || "Unknown";
    const location = latest.StatusLocation || latest.location || data.location || body.location || "Unknown";
    const instructions = latest.Instructions || latest.instructions || latest.remark || latest.activity || data.instructions || data.remarks || data.remark || body.instructions || body.remarks || body.remark || statusText;

    let timestamp = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const rawTime = latest.StatusDateTime;
    if (rawTime) {
      const parsedTime = new Date(rawTime);
      if (!isNaN(parsedTime.getTime())) {
        timestamp = parsedTime;
      }
    }

    if (!awb && !data.orderId) {
      console.warn("ShipexIndia Webhook: Missing AWB and Shipex orderId in webhook payload");
      return res.status(400).json({
        success: false,
        message: "AWB Number or Shipex Order ID missing from webhook payload",
      });
    }

    // Fetch Order by AWB or Shipex Order ID
    let order = null;
    if (awb) {
      order = await Order.findOne({ awb_number: String(awb) });
    }
    if (!order && data.orderId) {
      order = await Order.findOne({ shipment_id: String(data.orderId) });
    }

    if (!order) {
      console.warn(`ShipexIndia Webhook: Order not found for AWB: ${awb}, Shipex Order ID: ${data.orderId}`);
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Populate AWB if it was missing
    if (awb && !order.awb_number) {
      order.awb_number = String(awb);
    }

    if (["new", "Cancelled"].includes(order.status)) {
      console.log(
        `Skipping ShipexIndia Webhook for AWB ${awb} because order status is "${order.status}"`
      );
      return res.status(200).send("Ignored (Order Not Active)");
    }

    // ── Duplicate Tracking Check ──
    const isDuplicate = order.tracking.some((t) => {
      if (!t.StatusDateTime) return false;

      const tTime = new Date(t.StatusDateTime).getTime();
      const normTime = new Date(timestamp).getTime();

      // 1. Time must match exactly
      if (tTime !== normTime) return false;

      // 2. If time matches, check status/remarks
      const normStatus = String(statusText).toLowerCase().trim();
      const tStatus = String(t.status || t.Status || "").toLowerCase().trim();

      const normInstr = String(instructions).toLowerCase().trim();
      const tInstr = String(t.Instructions || "").toLowerCase().trim();

      return normStatus === tStatus || normInstr === tInstr;
    });

    if (isDuplicate) {
      console.log(`Duplicate tracking entry for AWB ${awb} at ${timestamp}. Skipping update.`);
      return res.status(200).json({
        success: true,
        message: "Duplicate tracking entry, update skipped",
      });
    }

    // Map Status
    const s = String(statusText).toUpperCase().trim();
    let mappedStatus = null;

    if (s.includes("DELIVERED") && s.includes("RTO")) {
      mappedStatus = "RTO Delivered";
    } else if (s.includes("RTO")) {
      mappedStatus = "RTO";
    } else if (s.includes("MANIFEST") || s.includes("READY TO SHIP") || s.includes("READY_FOR_DISPATCH") || s.includes("READY TO DISPATCH")) {
      mappedStatus = "Ready To Ship";
    } else if (s.includes("CONFIRMED") || s.includes("BOOKED")) {
      mappedStatus = "Booked";
    } else if (s.includes("DISPATCH") || s.includes("SHIPPED") || s.includes("TRANSIT")) {
      mappedStatus = "In-transit";
    } else if (s.includes("OUT_FOR_DELIVERY") || s.includes("OUT FOR DELIVERY")) {
      mappedStatus = "Out for Delivery";
    } else if (s.includes("UNDELIVERED") || s.includes("FAILED")) {
      mappedStatus = "Undelivered";
    } else if (s.includes("DELIVERED")) {
      mappedStatus = "Delivered";
    } else if (s.includes("CANCEL")) {
      mappedStatus = "Cancelled";
    } else if (s.includes("LOST")) {
      mappedStatus = "Lost";
    }

    // Apply state changes based on mapped status
    if (mappedStatus) {
      /* ========================================================
         RTO FLOW
      ======================================================== */
      if (mappedStatus.startsWith("RTO")) {
        order.reattempt = false;
        order.ndrStatus = mappedStatus;
        order.status = mappedStatus;
      } else {
        /* ========================================================
           FORWARD FLOW
        ======================================================== */
        order.status = mappedStatus;

        if (mappedStatus === "In-transit") {
          order.ndrStatus = "In-transit";
          order.reattempt = false;
          if (!order.invoiceDate) {
            order.invoiceDate = timestamp;
          }
        }

        if (mappedStatus === "Out for Delivery") {
          order.ndrStatus = "Out for Delivery";
          order.reattempt = false;
        }

        if (mappedStatus === "Delivered") {
          if (order.ndrHistory.length > 0) {
            order.ndrStatus = "Delivered";
            order.reattempt = true;
          } else {
            order.ndrStatus = "";
            order.reattempt = false;
          }
        }

        if (mappedStatus === "Lost") {
          order.ndrStatus = "Lost";
          order.reattempt = false;
        }

        /* ── Cancelled & Refund Flow ── */
        if (mappedStatus === "Cancelled") {
          order.ndrStatus = "Cancelled";

          const balanceToBeAdded = !order.totalFreightCharges || order.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(order.totalFreightCharges);

          if (balanceToBeAdded > 0 && !order.walletRefunded) {
            const userDoc = await User.findById(order.userId);
            if (userDoc) {
              const currentWallet = await Wallet.findById(userDoc.Wallet).select("balance");
              if (currentWallet) {
                // Try to atomically mark the order as walletRefunded: true
                const orderUpdated = await Order.findOneAndUpdate(
                  {
                    _id: order._id,
                    walletRefunded: { $ne: true }
                  },
                  {
                    $set: { walletRefunded: true, status: "Cancelled", ndrStatus: "Cancelled" }
                  },
                  { new: true }
                );

                if (orderUpdated) {
                  const mongoose = require("mongoose");
                  const session = await mongoose.startSession();
                  session.startTransaction();

                  try {
                    const alreadyRefunded = await WalletTransaction.exists({
                      walletId: currentWallet._id,
                      awb_number: order.awb_number,
                      category: "credit",
                      description: { $in: ["Freight Charges Received", "Freight Charges Refunded"] }
                    }).session(session);

                    if (!alreadyRefunded) {
                      const newBalance = (currentWallet.balance || 0) + balanceToBeAdded;
                      await Wallet.findOneAndUpdate(
                        { _id: currentWallet._id },
                        {
                          $inc: { balance: balanceToBeAdded },
                        },
                        { session }
                      );

                      await WalletTransaction.create(
                        [
                          {
                            walletId: currentWallet._id,
                            channelOrderId: order.orderId || null,
                            category: "credit",
                            amount: balanceToBeAdded,
                            balanceAfterTransaction: newBalance,
                            date: new Date(),
                            awb_number: order.awb_number,
                            description: "Freight Charges Received",
                          }
                        ],
                        { session }
                      );

                      console.log(
                        `ShipexIndia Webhook: Refunded ₹${balanceToBeAdded} for AWB ${order.awb_number} due to cancellation`
                      );
                    }

                    await session.commitTransaction();
                    session.endSession();
                  } catch (err) {
                    await session.abortTransaction();
                    session.endSession();
                    console.error("⚠️ Transaction failed in ShipexIndiaWebhook cancellation:", err.message);
                  }

                  order.walletRefunded = true;
                  order.status = "Cancelled";
                } else {
                  console.log(`ShipexIndia Webhook: Order ${order.awb_number} was already refunded/cancelled elsewhere. Skipping refund.`);
                  order.walletRefunded = true;
                  order.status = "Cancelled";
                }
              }
            }
          }
        }

        /* ── Undelivered / NDR Flow ── */
        if (mappedStatus === "Undelivered") {
          order.ndrStatus = "Undelivered";

          const currentDate = timestamp.getTime();
          let lastNdrDate = null;

          if (order.ndrHistory.length > 0) {
            const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
            const lastAction = lastHistory.actions[lastHistory.actions.length - 1];
            lastNdrDate = new Date(lastAction.date).getTime();
          }

          order.ndrReason = {
            date: timestamp,
            reason: instructions,
          };

          if (!lastNdrDate || currentDate > lastNdrDate) {
            const attemptCount = order.ndrHistory.length + 1;
            if (attemptCount <= 3) {
              order.reattempt = true;
              order.ndrHistory.push({
                actions: [
                  {
                    action: `NDR ${attemptCount} Raised`,
                    actionBy: order.provider || "ShipexIndia",
                    remark: instructions,
                    source: order.partner || "ShipexIndia",
                    date: timestamp,
                  },
                ],
              });
            }
          }
        }
      }
    }

    // Save tracking entry
    order.tracking.push({
      Instructions: instructions,
      status: mappedStatus || statusText,
      StatusDateTime: timestamp,
      StatusLocation: location,
    });

    await order.save();

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

    console.log(`ShipexIndia Webhook Processed for AWB: ${awb}, status: ${order.status}`);
    return res.status(200).json({
      success: true,
      message: "Webhook processed successfully",
    });
  } catch (error) {
    console.error("ShipexIndia Webhook Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { ShipexIndiaWebhook };
