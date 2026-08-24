const Order = require("../models/newOrder.model");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");

const EKART_WEBHOOK_TOKEN = process.env.EKART_WEBHOOK_TOKEN;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const ekartEpochToISTDate = (epoch) => {
  if (!epoch) return new Date();
  return new Date(epoch + IST_OFFSET_MS);
};

const EkartWebhook = async (req, res) => {
  try {
    // console.log("Ekart Webhook Received:", req.body);

    const body = req.body;

    const {
      status,
      location,
      desc,
      attempts,
      wbn, // AWB number
      edd,
      ctime,
      latestNdrStatus,
      ndrDesc,
      ndrCtime,
    } = body;

    if (!wbn) {
      return res.status(400).json({
        success: false,
        message: "AWB Number missing from Ekart webhook payload",
      });
    }

    // Fetch order
    const order = await Order.findOne({ awb_number: wbn });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const descLower = (desc || "").toLowerCase().trim();
    const isReadyToShipDesc = descLower.includes("dispached by quickpost") || descLower.includes("consignment manifested");

    if (order.status === "Cancelled") {
      console.log(
        `Skipping Ekart Webhook for AWB ${wbn} because order status is "${order.status}"`,
      );
      return res.status(200).send("Ignored (Order Cancelled)");
    }

    if (order.status === "new" && !isReadyToShipDesc) {
      console.log(
        `Skipping Ekart Webhook for AWB ${wbn} because order status is "new" and description is not a manifest status`,
      );
      return res.status(200).send("Ignored (Order Not Yet Shipped)");
    }

    // Normalize Ekart data (same structure as Shree Maruti)
    const normalizedData = {
      Status: status,
      Instructions: desc,
      StrRemarks: desc,
      StatusDateTime: ekartEpochToISTDate(ctime),
    };

    // ------------------------------------------------
    // DUPLICATE TRACKING CHECK (More robust)
    // ------------------------------------------------
    const isDuplicate = order.tracking.some((t) => {
      if (!t.StatusDateTime) return false;

      const tTime = new Date(t.StatusDateTime).getTime();
      const normTime = new Date(normalizedData.StatusDateTime).getTime();

      // 1. Time must match exactly
      if (tTime !== normTime) return false;

      // 2. If time matches, check if status, instructions or location matches (case-insensitive)
      const normStatus = (normalizedData.Status || "").toLowerCase().trim();
      const tStatus = (t.status || t.Status || "").toLowerCase().trim();

      const normInstr = (normalizedData.Instructions || "").toLowerCase().trim();
      const tInstr = (t.Instructions || "").toLowerCase().trim();

      const normLoc = (location || "").toLowerCase().trim();
      const tLoc = (t.StatusLocation || "").toLowerCase().trim();

      return (
        normStatus === tStatus ||
        normInstr === tInstr ||
        (normLoc && normLoc === tLoc)
      );
    });

    if (isDuplicate) {
      console.log(`Duplicate tracking entry for AWB ${wbn} at ${normalizedData.StatusDateTime}. Skipping update.`);
      return res.status(200).json({
        success: true,
        message: "Duplicate tracking entry, update skipped",
      });
    }

    const currentStatus = normalizedData.Status;

    if (descLower.includes("mark_not_received")) {
      if (order.status !== "Cancelled") {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        order.reattempt = false;

        const User = require("../models/User.model");
        const Wallet = require("../models/wallet");
        const WalletTransaction = require("../models/WalletTransaction.model");

        const userDoc = await User.findById(order.userId);
        if (userDoc && userDoc.Wallet) {
          const balanceTobeAdded = order.totalFreightCharges === "N/A" || !order.totalFreightCharges
            ? 0
            : parseFloat(order.totalFreightCharges);

          if (balanceTobeAdded > 0) {
            const existingCount = await WalletTransaction.countDocuments({
              walletId: userDoc.Wallet,
              awb_number: order.awb_number || "",
              category: "credit",
              description: "Freight Charges Received",
            });

            if (existingCount === 0) {
              await Wallet.updateOne(
                { _id: userDoc.Wallet },
                { $inc: { balance: balanceTobeAdded } }
              );

              const updatedWallet = await Wallet.findById(userDoc.Wallet).select("balance");

              await WalletTransaction.create({
                walletId: userDoc.Wallet,
                channelOrderId: order.orderId || null,
                category: "credit",
                amount: balanceTobeAdded,
                balanceAfterTransaction: updatedWallet.balance,
                date: new Date(),
                awb_number: order.awb_number || "",
                description: "Freight Charges Received",
              });
              console.log(`[EkartWebhook] Refunded ${balanceTobeAdded} to wallet for cancelled AWB ${order.awb_number}`);
            }
          }
        }
      }

      order.tracking.push({
        Instructions: normalizedData.Instructions,
        status: "Cancelled", // must be lowercase to match the schema (models/newOrder.model.js) — capitalized "Status" was silently dropped by Mongoose's strict mode
        StatusDateTime: normalizedData.StatusDateTime,
        StatusLocation: location || "Unknown",
      });

      await order.save();

      return res.status(200).json({
        success: true,
        message: "Ekart shipment marked as Cancelled due to mark_not_received",
      });
    }

    /* ========================================================
       ==============   FORWARD FLOW HANDLING   ===============
       ======================================================== */

    if (isReadyToShipDesc) {
      order.status = "Ready To Ship";
      order.ndrStatus = "Ready To Ship";
      order.reattempt = false;
    } else if (currentStatus === "Picked Up") {
      order.status = "In-transit";
      order.ndrStatus = "In-transit";
      if (!order.invoiceDate) {
        order.invoiceDate = normalizedData.StatusDateTime;
      }
      order.reattempt = false;
    }

    if (currentStatus === "In Transit" || currentStatus === "Reached Hub") {
      order.status = "In-transit";
      order.ndrStatus = "In-transit";
      order.reattempt = false;
    }

    if (currentStatus === "Out for Delivery") {
      order.status = "Out for Delivery";
      order.ndrStatus = "Out for Delivery";
      order.reattempt = false;
    }

    /* ========================================================
         DELIVERED LOGIC
    ======================================================== */
    if (currentStatus === "Delivered" || descLower.includes("delivered to")) {
      order.status = "Delivered";

      if (order.ndrHistory.length > 0) {
        order.ndrStatus = "Delivered";
        order.reattempt = false;
      } else {
        order.ndrStatus = "";
        order.reattempt = false;
      }
    }

    /* ========================================================
         RTO LOGIC
    ======================================================== */
    if (currentStatus === "RTO" || currentStatus === "RTO Requested") {
      order.status = "RTO";
      order.ndrStatus = "RTO";
      order.reattempt = false;
    }


    if (currentStatus === "RTO In Transit") {
      order.status = "RTO In-transit";
      order.ndrStatus = "RTO In-transit";
      order.reattempt = false;
    }

    if (currentStatus === "RTO Delivered") {
      order.status = "RTO Delivered";
      order.ndrStatus = "RTO Delivered";
      order.reattempt = false;
    }


    /* ========================================================
         UNDELIVERED → NDR LOGIC (Triggered by latestNdrStatus)
    ======================================================== */
    const EKART_NDR_STATUSES = [
      "Unknown Exception",
      "Customer Unavailable",
      "Rejected by Customer",
      "Delivery Rescheduled",
      "Pickup Rescheduled",
      "Customer Unreachable",
      "Address Issue",
      "Payment Issue",
      "Out Of Delivery Area",
      "Order Already Cancelled",
      "Self Collect",
      "Shipment Seized By Customer",
      "Dispute",
      "Maximum Attempt Reached",
      "Not Attempted",
      "OTP Not Received/OTP Mismatch",
      "OTP Verified Cancellation",
      "On Hold",
      "RTO Delivery Failed"
    ];

    const normalizedNdrStatuses = EKART_NDR_STATUSES.map(s => s.toLowerCase().trim());
    const isEligibleForNdr =
      latestNdrStatus &&
      normalizedNdrStatuses.includes(latestNdrStatus.toLowerCase().trim());

    if (isEligibleForNdr && currentStatus !== "RTO In Transit") {
      order.status = "Undelivered";
      order.ndrStatus = "Undelivered";
      order.reattempt=false;

      const ndrDate = ndrCtime ? ekartEpochToISTDate(ndrCtime) : normalizedData.StatusDateTime;
      const ndrReasonText = ndrDesc || latestNdrStatus || normalizedData.StrRemarks || "";
      const currentDate = ndrDate.getTime();

      // last NDR date
      let lastNdrDate = null;
      if (order.ndrHistory.length > 0) {
        const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
        const lastAction = lastHistory.actions[lastHistory.actions.length - 1];
        lastNdrDate = new Date(lastAction.date).getTime();
      }

      const attemptCount = order.ndrHistory.length + 1;

      // store NDR reason
      order.ndrReason = {
        date: ndrDate,
        reason: ndrReasonText,
      };

      /* ───────────────────────────────────────────────
         BLOCK DUPLICATE / OLDER NDR
      ─────────────────────────────────────────────── */
      if (
        order.ndrStatus === "Action_Requested" &&
        lastNdrDate &&
        currentDate <= lastNdrDate
      ) {
        console.log("NDR IGNORE: Duplicate or older Ekart UNDELIVERED based on ndrCtime");
      } else if (!lastNdrDate || currentDate > lastNdrDate) {
        /* ───────────────────────────────────────────────
           VALID NDR CASE
        ─────────────────────────────────────────────── */
        order.reattempt = true;

        order.ndrHistory.push({
          actions: [
            {
              action: `NDR ${attemptCount} Raised`,
              actionBy: order.provider,
              remark: ndrReasonText,
              source: order.provider,
              date: ndrDate,
            },
          ],
        });
      }
    }

    /* ========================================================
       ===============   SAVE TRACKING ENTRY   ================
       ======================================================== */
    order.tracking.push({
      Instructions: normalizedData.Instructions,
      status: normalizedData.Status, // must be lowercase to match the schema — capitalized "Status" was silently dropped by Mongoose's strict mode
      StatusDateTime: normalizedData.StatusDateTime,
      StatusLocation: location || "Unknown",
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

    return res.status(200).json({
      success: true,
      message: "Ekart webhook processed successfully",
    });
  } catch (error) {
    console.error("Ekart Webhook Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { EkartWebhook };
