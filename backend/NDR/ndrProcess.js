const {
  getOrderDetails,
  callShiprocketNdrApi,
  callNimbustNdrApi,
  callEcomExpressNdrApi,
  callSmartshipNdrApi,
  handleDelhiveryNdrAction,
  submitNdrToDtdc,
  submitNdrToAmazon,
  submitNdrToZipypost,
  submitNdrToShreeMaruti,
  submitNdrToEkart,
  submitNdrToBoxdLogistics,
} = require("../services/ndrService");
const { runNdrTask } = require("../utils/ndrTaskRunner");
const FailedNdrAction = require("../models/FailedNdrAction.model");
const Order = require("../models/newOrder.model");

const pushNdrActionToHistory = (order, entry) => {
  if (!Array.isArray(order.ndrHistory)) {
    order.ndrHistory = [];
  }
  if (order.ndrHistory.length > 0) {
    const latest = order.ndrHistory[order.ndrHistory.length - 1];
    if (latest.actions && Array.isArray(latest.actions) && latest.actions.length < 2) {
      latest.actions.push(entry);
    } else {
      order.ndrHistory.push({ actions: [entry] });
    }
  } else {
    order.ndrHistory.push({ actions: [entry] });
  }
};

const isNdrAlreadyRaisedToday = (order) => {
  if (!order.ndrHistory || !Array.isArray(order.ndrHistory) || order.ndrHistory.length === 0) {
    return false;
  }

  const todayISTStr = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" });

  return order.ndrHistory.some(historyItem => {
    if (historyItem.actions && Array.isArray(historyItem.actions)) {
      return historyItem.actions.some(action => {
        if (!action.date) return false;
        return new Date(action.date).toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" }) === todayISTStr;
      });
    }
    return false;
  });
};

const ndrProcessController = async (req, res) => {
  const { awb_number } = req.body;

  const orderDetails = await Order.findOne({ awb_number: awb_number });
  if (!orderDetails) {
    return res.status(404).json({ error: "Order not found" });
  }



  try {
    const response = await runNdrTask(orderDetails._id, req.body);

    if (response.success) {
      return res.json({
        success: true,
        message: response.message || "NDR action processed successfully",
        data: response.data,
      });
    } else {
      console.warn(`Immediate NDR failed for ${awb_number}, queuing for retry: ${response.message || response.error}`);

      // Move to Action_Requested even if it failed and queued, so user doesn't see it in Action Required
      orderDetails.ndrStatus = "Action_Requested";
      orderDetails.status = "Action_Requested";
      orderDetails.reattempt = false;
      const queuedEntry = {
        action: req.body.action,
        actionBy: "Shiproxx",
        remark: req.body.remarks || req.body.comments || "NDR Action Requested",
        source: "Shiproxx",
        date: new Date(),
      };
      pushNdrActionToHistory(orderDetails, queuedEntry);
      await orderDetails.save();

      await FailedNdrAction.create({
        orderId: orderDetails._id,
        awb_number: awb_number,
        action: req.body.action,
        payload: req.body,
        lastError: response.message || response.error || "Initial attempt failed",
        lastAttemptAt: new Date(),
        status: "failed",
      });

      return res.json({
        success: true,
        message: "Action submitted successfully and queued for background processing.",
      });
    }
  } catch (error) {
    console.error("NDR Controller Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error in NDR processing",
    });
  }
};

const ndrBulkProcessController = async (req, res) => {
  try {
    let payloads = req.body.payloads;

    // Support both wrapped { payloads: [] } and direct array [ ... ]
    if (!payloads && Array.isArray(req.body)) {
      payloads = req.body;
    }

    console.log("Bulk NDR Request Body:", JSON.stringify(req.body, null, 2));
    console.log("Extracted Payloads:", payloads);

    if (!payloads || !Array.isArray(payloads) || payloads.length === 0) {
      console.error("Validation failed: payloads is empty or not an array");
      return res
        .status(400)
        .json({
          success: false,
          message: "No NDR payloads provided",
          receivedBody: req.body
        });
    }

    const eligiblePayloads = [];
    const skippedAlreadyRaised = [];
    const skippedNotFound = [];

    // Pre-validation and immediate status/history updates to reflect in UI immediately
    for (const p of payloads) {
      const { orderId } = p;
      const order = await Order.findById(orderId);

      if (!order) {
        skippedNotFound.push(orderId);
        continue;
      }



      // Transition immediately to "Action_Requested" status
      order.ndrStatus = "Action_Requested";
      order.status = "Action_Requested";
      order.reattempt = false;
      await order.save();

      eligiblePayloads.push({ order, payload: p });
    }

    // Return immediate response to the UI
    res.json({
      success: true,
      message: `Bulk NDR process initiated in background. ${eligiblePayloads.length} shipments marked as processing.`,
      summary: {
        totalReceived: payloads.length,
        processingCount: eligiblePayloads.length,
        alreadyRaisedCount: skippedAlreadyRaised.length,
        notFoundCount: skippedNotFound.length,
        alreadyRaised: skippedAlreadyRaised,
      }
    });

    // Run the actual API calls in the background asynchronously
    (async () => {
      for (const item of eligiblePayloads) {
        const { order, payload } = item;
        try {
          console.log(`[Background NDR] Processing AWB: ${order.awb_number}`);
          const apiResponse = await runNdrTask(order._id, payload);
          const isSuccess = apiResponse?.success === true;

          // Reload fresh order document from DB to prevent overwriting other updates
          const freshOrder = await Order.findById(order._id);
          if (!freshOrder) continue;

          if (isSuccess) {
            console.log(`[Background NDR] Successfully raised for AWB: ${order.awb_number}`);
          } else {
            console.warn(`[Background NDR] Failed for AWB: ${order.awb_number}, creating FailedNdrAction`);

            // Reload fresh order document from DB to prevent overwriting other updates
            const freshOrder = await Order.findById(order._id);
            if (freshOrder) {
              const queuedEntry = {
                action: payload.action,
                actionBy: "Shiproxx",
                remark: payload.remarks || payload.comments || "NDR Action Requested",
                source: "Shiproxx",
                date: new Date(),
              };
              pushNdrActionToHistory(freshOrder, queuedEntry);
              await freshOrder.save();
            }

            // Create background retry entry
            await FailedNdrAction.create({
              orderId: order._id,
              awb_number: order.awb_number,
              action: payload.action,
              payload: payload,
              lastError: apiResponse?.message || apiResponse?.error || "Initial attempt failed",
              lastAttemptAt: new Date(),
              status: "failed",
            });
          }
        } catch (backgroundError) {
          console.error(`[Background NDR] Unexpected error for order ID ${orderId}:`, backgroundError);
        }
      }
    })();

  } catch (error) {
    console.error("Bulk NDR Controller Error:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Internal server error in bulk NDR",
      });
    }
  }
};

module.exports = { ndrProcessController, ndrBulkProcessController, isNdrAlreadyRaisedToday };
