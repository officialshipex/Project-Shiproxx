const cron = require("node-cron");
const Order = require("../models/newOrder.model");
const FailedNdrAction = require("../models/FailedNdrAction.model");
const { runNdrTask } = require("../utils/ndrTaskRunner");

console.log("NDR Cron Jobs Initialized: 4 AM consolidated and Hourly Retry jobs.");

/**
 * Retries failed NDR actions from the queue (previous day's failed actions only).
 * Capped at 3 total attempts, and does NOT update ndrHistory.
 */
const processFailedNdrActions = async () => {
  try {
    console.log("Processing failed NDR actions from the queue...");
    const failedActions = await FailedNdrAction.find({
      status: { $in: ["pending", "failed"] },
      retryCount: { $lt: 3 }, // Limit to 3 attempts
    });

    for (const action of failedActions) {
      console.log(`Retrying NDR for AWB: ${action.awb_number} (Retry #${action.retryCount + 1})`);
      const result = await runNdrTask(action.orderId, action.payload);

      if (result.success) {
        action.status = "completed";
        action.lastError = null;
      } else {
        action.status = "failed";
        action.lastError = result.message || result.error || "Unknown error";
        action.retryCount += 1;

        if (action.retryCount >= 3) {
          const order = await Order.findById(action.orderId);
          if (order) {
            order.ndrStatus = "Undelivered";
            order.status = "Undelivered";
            order.reattempt = false;
            await order.save();
          }
        }
      }
      action.lastAttemptAt = new Date();
      await action.save();
    }
  } catch (error) {
    console.error("Error during failed NDR actions retry:", error);
  }
};

if (process.env.NODE_ENV === "production") {
  /**
   * Hourly NDR Retry Job (runs at 5 minutes past the hour, e.g., 4:05, 5:05, 6:05)
   */
  cron.schedule("5 * * * *", async () => {
    console.log("Running Hourly NDR Retry Job...");
    await processFailedNdrActions();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });

  /**
   * Consolidated Daily NDR Job (4 AM IST)
   */
  cron.schedule("0 4 * * *", async () => {
    console.log("Running Consolidated Daily 4 AM NDR Job...");

    // --- PART 1: Retry previously failed actions ---
    await processFailedNdrActions();

    // --- PART 2: New Daily Auto Re-attempts ---
    try {
      const eligibleOrders = await Order.find({
        ndrStatus: "Undelivered",
        reattempt: true,
        status: "Undelivered",
      });

      console.log(`Found ${eligibleOrders.length} new orders for daily re-attempt.`);

      for (const order of eligibleOrders) {
        try {
          const actionDetails = {
            action: "RE-ATTEMPT",
            remarks: "Kindly Reattempt on priority basis.",
            comments: "Kindly Reattempt on priority basis.",
          };

          console.log(`Triggering daily re-attempt for AWB: ${order.awb_number}`);
          const result = await runNdrTask(order._id, actionDetails);

          // If runNdrTask was successful, it has already updated and saved the order document in the DB.
          // If it failed, we reload a fresh copy of the document to update it, avoiding version conflicts.
          if (!result || !result.success) {
            const freshOrder = await Order.findById(order._id);
            if (freshOrder) {
              freshOrder.ndrStatus = "Action_Requested";
              freshOrder.status = "Action_Requested";
              freshOrder.reattempt = false;
              if (!Array.isArray(freshOrder.ndrHistory)) freshOrder.ndrHistory = [];
              const autoEntry = {
                action: "RE-ATTEMPT",
                actionBy: "ShipexIndia",
                remark: "Kindly Reattempt on priority basis.",
                source: "ShipexIndia",
                date: new Date(),
              };
              freshOrder.ndrHistory.push({ actions: [autoEntry] });
              await freshOrder.save();
            }

            await FailedNdrAction.create({
              orderId: order._id,
              awb_number: order.awb_number,
              action: "RE-ATTEMPT",
              payload: actionDetails,
              lastError: result?.message || result?.error || "Re-attempt failed",
              lastAttemptAt: new Date(),
              status: "failed"
            });
          }
        } catch (orderError) {
          console.error(`Error processing daily re-attempt for AWB ${order.awb_number}:`, orderError);
        }
      }
    } catch (error) {
      console.error("Error during new daily re-attempts:", error);
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
}



