const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const statusMap = require("../statusMap/StatusMap.model");
const { formatDTDCDateTime } = require("../Orders/tracking.controller");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");

const DTDC_WEBHOOK_TOKEN = process.env.DTDC_WEBHOOK_TOKEN;

const DTDCWebhook = async (req, res) => {
  try {
    const token = req.headers.authorization;
    console.log("DTDC Webhook Token:", token);

    if (token !== DTDC_WEBHOOK_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    console.log("DTDC Webhook Received:", req.body);

    const { shipment, shipmentStatus } = req.body;

    if (!shipment || !shipment.strShipmentNo || !shipmentStatus?.length) {
      return res.status(400).send("Invalid Webhook Format");
    }

    const awb = shipment.strShipmentNo.trim();

    const order = await Order.findOne({ awb_number: awb });
    if (!order) {
      return res.status(404).send("Order not found");
    }

    const oldStatus = order.status; // kept for logging only

    if (["new", "Cancelled"].includes(order.status)) {
      console.log(
        `Skipping Dtdc Webhook for AWB ${awb} because order status is "${order.status}"`,
      );
      return res.status(200).send("Ignored (Order Not Yet Shipped)");
    }

    // ✔ SORT ALL EVENTS BY DATETIME
    const sortedEvents = shipmentStatus
      .map((ev) => ({
        ...ev,
        fullDate: formatDTDCDateTime(ev.strActionDate, ev.strActionTime),
      }))
      .sort((a, b) => new Date(a.fullDate) - new Date(b.fullDate));

    const statusDoc = await statusMap.findOne(
      { partnerName: "DTDC" },
      { data: 1 },
    );

    let shouldUpdateWallet = false;
    let balanceTobeAdded = 0;

    // -------------------------------------------
    // ✔ PROCESS EACH TRACKING EVENT ONE BY ONE
    // -------------------------------------------
    for (const ev of sortedEvents) {
      if (!statusDoc) continue;

      const dbMapping = statusDoc.data.find(
        (d) => d.code?.toLowerCase() === ev?.strAction?.toLowerCase(),
      );

      if (!dbMapping) continue;

      const normalizedData = {
        Status: dbMapping.sy_status || "",
        StatusDateTime: formatDTDCDateTime(ev.strActionDate, ev.strActionTime),
        Instructions: ev.strActionDesc || "",
        StatusLocation: ev.strOrigin || "",
        StrRemarks: ev.strRemarks === "null" ? "" : ev.strRemarks || "",
      };

      // Add into tracking history
      order.tracking.push({
        status: normalizedData.Status,
        StatusDateTime: normalizedData.StatusDateTime,
        StatusLocation: normalizedData.StatusLocation,
        Instructions: normalizedData.Instructions,
      });
      if (dbMapping.sy_status === "In-transit" && !order.invoiceDate) {
        order.invoiceDate = normalizedData.StatusDateTime;
      }

      // Update main mapped status
      order.status = dbMapping.sy_status;

      const isPureNDREligible =
        normalizedData.Status === "SETRTO" &&
        order.ndrStatus !== "Action_Requested";

      // -------------------------------------------
      // ✔ UNDELIVERED (any code including SETRTO)
      // -------------------------------------------
      if (dbMapping.sy_status === "Undelivered") {
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";

        const newDate = new Date(normalizedData.StatusDateTime);
        const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
        const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
        const lastDate = lastAction ? new Date(lastAction.date) : null;

        const canAddNewEntry =
          !lastDate || newDate.getTime() > lastDate.getTime();

        if (canAddNewEntry) {
          const attempt = order.ndrHistory.length + 1;
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.StrRemarks,
          };
          order.ndrHistory.push({
            actions: [
              {
                action: `NDR ${attempt} Raised`,
                actionBy: order.provider,
                remark: normalizedData.StrRemarks,
                source: order.provider,
                date: normalizedData.StatusDateTime,
              },
            ],
          });
        }

        order.reattempt = isPureNDREligible ? true : false;
      }

      // -------------------------------------------
      // ✔ Delivered
      // -------------------------------------------
      if (dbMapping.code === "DLV") {
        if (order.ndrHistory.length > 0) {
          order.status = "Delivered";
          order.ndrStatus = "Delivered";
        } else {
          order.status = "Delivered";
          order.ndrStatus = null;
        }
        order.reattempt = false;
      }

      // -------------------------------------------
      // ✔ Refund Logic
      // -------------------------------------------
      if (
        normalizedData.Instructions === "Return as per client instruction." &&
        order.tracking.length <= 3
      ) {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";

        balanceTobeAdded =
          order.totalFreightCharges === "N/A"
            ? 0
            : parseInt(order.totalFreightCharges);

        shouldUpdateWallet = true;
      }

      // -------------------------------------------
      // ✔ Default: Not eligible for NDR
      // -------------------------------------------
      if (dbMapping.sy_status !== "Undelivered" && !isPureNDREligible) {
        order.reattempt = false;
      }
    }

    // -------------------------------------------
    // ✔ Update Wallet if needed
    // -------------------------------------------
    if (shouldUpdateWallet && balanceTobeAdded > 0) {
      const walletDoc = await Wallet.findById(order.walletId).select("balance");
      if (walletDoc) {
        const newBalance = (walletDoc.balance || 0) + balanceTobeAdded;
        await Wallet.updateOne(
          { _id: walletDoc._id },
          {
            $inc: { balance: balanceTobeAdded },
          }
        );

        await WalletTransaction.create({
          walletId: walletDoc._id,
          channelOrderId: order.orderId || null,
          category: "credit",
          amount: balanceTobeAdded,
          balanceAfterTransaction: newBalance,
          date: new Date(),
          awb_number: order.awb_number,
          description: "Freight Charges Received",
        }).catch(err => console.error("⚠️ WalletTransaction dual-write failed for DtdcWebhook:", err.message));
      }
    }

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

    console.log("DTDC Webhook Processed for AWB:", awb);
    return res.status(200).send("Webhook Processed");
  } catch (err) {
    console.error("DTDC Webhook Error:", err.message);
    return res.status(500).send("Internal Server Error");
  }
};

module.exports = { DTDCWebhook };

// {
//   "shipment": {
//     "strRefNo": "579511",
//     "strOrigin": "INDORE",
//     "strWeight": "0.5",
//     "strBookedOn": "27112025",
//     "strCNProduct": "PRIORITY",
//     "strRtoNumber": "",
//     "strCNTypeCode": "GL9711",
//     "strShipmentNo": "7X105009916",
//     "strExpectedDeliveryDate": "",
//     "strRevExpectedDeliveryDate": ""
//   },

//   "shipmentStatus": [
//     {
//       "strAction": "PCSC",
//       "strOrigin": "INDORE VIJAYNAGAR BRANCH , INDORE",
//       "strRemarks": "",
//       "strLatitude": "",
//       "strLongitude": "",
//       "strActionDate": "27112025",
//       "strActionDesc": "Pickup Scheduled",
//       "strActionTime": "133952",
//       "strManifestNo": "7641991541779"
//     }
//   ]
// }
