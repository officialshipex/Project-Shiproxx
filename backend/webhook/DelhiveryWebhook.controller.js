const Order = require("../models/newOrder.model");
const statusMap = require("../statusMap/StatusMap.model");
const { isReAttemptEligible } = require("../Orders/tracking.controller");
const cron = require("node-cron");
const { trackShipmentDelhivery } = require("../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");

const DELHIVERY_WEBHOOK_TOKEN = process.env.DELHIVERY_WEBHOOK_TOKEN;

const eligibleNSLCodes = [
  "EOD-74",
  "EOD-15",
  "EOD-104",
  "EOD-43",
  "EOD-86",
  "EOD-11",
  "EOD-69",
  "EOD-6",
];

const DelhiveryWebhook = async (req, res) => {
  try {
    const token = req.headers.authorization;
    console.log("Delhivery Webhook Token:", token);

    if (token !== `Bearer ${DELHIVERY_WEBHOOK_TOKEN}`) {
      return res.status(401).send("Unauthorized");
    }

    const body = req.body?.Shipment;
    if (!body) return res.status(400).send("Invalid Payload");

    console.log("Webhook Scan Received from Delhivery:", body);

    // Extract values
    const awb = body.AWB;
    const referenceNo = body.ReferenceNo;
    const statusObj = body.Status || {};

    const normalizedData = {
      AWB: awb,
      Status: statusObj.Status,
      StatusDateTime: statusObj.StatusDateTime,
      StatusType: statusObj.StatusType,
      StatusLocation: statusObj.StatusLocation,
      Instructions: statusObj.Instructions,
      StatusCode: body.NSLCode,
    };

    // Find Order
    const order = await Order.findOne({ awb_number: awb });
    if (!order) {
      console.log("Order not found for AWB:", awb);
      return res.status(200).send("Order Not Found");
    }

    if (["new", "Cancelled"].includes(order.status)) {
      console.log(
        `Skipping Delhivery Webhook for AWB ${awb} because order status is "${order.status}"`,
      );
      return res.status(200).send("Ignored (Order Not Yet Shipped)");
    }
    const provider = "Delhivery";

    // -------------------------------
    // 1️⃣ GET MAPPING FROM statusMap
    // -------------------------------
    const statusDoc = await statusMap.findOne(
      { partnerName: provider.toUpperCase() },
      { data: 1 },
    );

    if (statusDoc) {
      function normalizeString(str) {
        return str
          ?.toLowerCase()
          .replace(/['"]/g, "") // remove apostrophes and quotes
          .replace(/[^a-z0-9]/gi, "") // remove all non-alphanumeric characters
          .trim();
      }

      const dbMapping = statusDoc.data.find(
        (d) =>
          normalizeString(d.scan_type) ===
          normalizeString(normalizedData.StatusType) &&
          normalizeString(d.scan) === normalizeString(normalizedData.Status) &&
          normalizeString(d.instructions) ===
          normalizeString(normalizedData.Instructions),
      );

      if (dbMapping) {
        order.status = dbMapping.sy_status;
        order.ndrStatus = dbMapping.sy_status;

        if (dbMapping.sy_status === "In-transit" && !order.invoiceDate) {
          order.invoiceDate = normalizedData.StatusDateTime;
        }

        if (order.status === "RTO Delivered") order.ndrStatus = "RTO Delivered";

        if (["RTO", "RTO In-transit"].includes(order.status)) {
          order.ndrStatus = order.status;
        }
      }
    }

    // -----------------------------------------------
    // 2️⃣ DELIVERED CASE HANDLING (WITH NDR HISTORY)
    // -----------------------------------------------
    if (normalizedData.Status === "Delivered") {
      if (order.ndrHistory.length > 0) {
        order.status = "Delivered";
        order.ndrStatus = "Delivered";
      } else {
        order.status = "Delivered";
      }
    }

    // --------------------------------
    // 3️⃣ NDR ELIGIBILITY BASED ON NSL
    // --------------------------------

    const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
    const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];

    const lastEntryDate = lastAction?.date
      ? new Date(lastAction.date).getTime()
      : null;
    const currentStatusDate = new Date(normalizedData.StatusDateTime).getTime();

    if (
      (order.ndrHistory.length === 0 || lastEntryDate < currentStatusDate)
      // order.ndrHistory.length <= 3
    ) {
      if (
        normalizedData.StatusCode &&
        eligibleNSLCodes.includes(normalizedData.StatusCode)
      ) {
        order.ndrStatus = "Undelivered";
        order.status = "Undelivered";
        order.reattempt = false;

        order.ndrReason = {
          date: normalizedData.StatusDateTime,
          reason: normalizedData.Instructions,
        };

        const attemptCount = order.ndrHistory.length + 1;

        const newHistoryEntry = {
          actions: [
            {
              action: `NDR ${attemptCount} Raised`,
              actionBy: order.provider,
              remark: normalizedData.Instructions,
              source: order.provider,
              date: normalizedData.StatusDateTime,
            },
          ],
        };

        order.ndrHistory.push(newHistoryEntry);
      }
    }
    order.tracking.push({
      status: normalizedData.Status,
      StatusDateTime: normalizedData.StatusDateTime,
      StatusLocation: normalizedData.StatusLocation,
      Instructions: normalizedData.Instructions,
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

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Delhivery Webhook Error:", error);
    res.status(500).send("Server Error");
  }
};

const processDelhiveryNdrReattempt = async () => {
  try {
    const orders = await Order.find({
      provider: "Delhivery",
      ndrStatus: "Undelivered",
      // awb_number: "35973710080695"
    });

    if (!orders || orders.length === 0) {
      console.log("No Delhivery Undelivered orders found for reattempt check.");
      return;
    }

    console.log(
      `Checking reattempt eligibility for ${orders.length} Delhivery Undelivered orders...`,
    );

    for (const order of orders) {
      try {
        const trackingResult = await trackShipmentDelhivery(order.awb_number);
        if (
          trackingResult.success &&
          Array.isArray(trackingResult.data) &&
          trackingResult.data.length > 0
        ) {
          // Latest scan is generally at the end of the array from trackShipmentDelhivery
          const scans = trackingResult.data;
          const latestScan = scans[scans.length - 1];
          const statusCode = latestScan.StatusCode;

          if (statusCode && eligibleNSLCodes.includes(statusCode)) {
            order.reattempt = true;
            await order.save();
            console.log(
              `AWB ${order.awb_number}: Reattempt set to true (StatusCode: ${statusCode})`,
            );
          }
        }
      } catch (err) {
        console.error(`Error tracking AWB ${order.awb_number}:`, err.message);
      }
    }
    console.log("Delhivery NDR reattempt check completed.");
  } catch (error) {
    console.error("Error in processDelhiveryNdrReattempt cron task:", error);
  }
};

// Run every day at 9:05 PM IST
if (process.env.NODE_ENV === "production") {
  cron.schedule(
    "5 21 * * *",
    () => {
      console.log(
        "⏰ Running scheduled Delhivery reattempt task at 9:05 PM IST",
      );
      processDelhiveryNdrReattempt();
    },
    {
      scheduled: true,
      timezone: "Asia/Kolkata",
    },
  );
}

// processDelhiveryNdrReattempt()

module.exports = { DelhiveryWebhook, processDelhiveryNdrReattempt };

//  Webhook Scan Received from Delhivery: {
//    Shipment: {
//      AWB: '35973710051170',
//      ReferenceNo: '192890',
//      PickUpDate: '2025-11-11T15:40:20',
//      Sortcode: 'AKK/MPP',
//      NSLCode: 'X-IBD3F',
//      Status: {
//        Status: 'In Transit',
//        StatusDateTime: '2025-11-26T14:45:46.886000',
//        StatusType: 'RT',
//        StatusLocation: 'Akola_Midcphase3_H (Maharashtra)',
//        Instructions: 'Shipment Received at Facility'
//      }
//    }
//  }
