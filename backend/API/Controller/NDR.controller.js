const Order = require("../../models/newOrder.model");
const {
  callEcomExpressNdrApi,
  callSmartshipNdrApi,
  handleDelhiveryNdrAction,
  submitNdrToDtdc,
  submitNdrToAmazon,
} = require("../../services/ndrService");

const exceptionList = async (req, res) => {
  try {
    const userId = req.user._id;

    // Fetch orders that specifically require action (Action Required logic)
    const orders = await Order.find(
      { 
        userId, 
        ndrStatus: "Undelivered",
        reattempt: true 
      },
      {
        awb_number: 1,
        courier: 1,
        reattempt: 1,
        ndrReason: 1,
        ndrHistory: 1,
        _id: 0,
      }
    );

    if (!orders || orders.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No shipments requiring NDR action found for this user",
      });
    }

    const filteredOrders = orders; // No need for extra courier filtering if we use ndrStatus/reattempt

    if (filteredOrders.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No matching undelivered orders found after filtering",
      });
    }

    // Format response
    const formattedData = filteredOrders.map((order) => ({
      awb_number: order.awb_number,
      courier: order.courier,
      date: order.ndrReason?.date || null,
      remark: order.ndrReason?.remark || null,
      attemptCount: order.ndrHistory ? order.ndrHistory.length : 0,
    }));

    res.status(200).json({
      success: true,
      count: formattedData.length,
      data: formattedData,
    });
  } catch (error) {
    console.error("Error fetching exception list:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const ndrCreate = async (req, res) => {
  try {
    const { awb_number } = req.body;
    const userId = req.user._id;

    if (!awb_number) {
      return res.status(400).json({
        success: false,
        message: "awb_number is required",
      });
    }

    // Fetch order for reference
    const orderDetails = await Order.findOne({
      userId,
      awb_number,
      ndrStatus: "Undelivered", // Only allowed for undelivered orders
    });

    if (!orderDetails) {
      return res.status(404).json({
        success: false,
        message: "No undelivered order found for the provided AWB number.",
      });
    }

    const { isNdrAlreadyRaisedToday } = require("../../NDR/ndrProcess");
    const { runNdrTask } = require("../../utils/ndrTaskRunner");
    const FailedNdrAction = require("../../models/FailedNdrAction.model");

    if (isNdrAlreadyRaisedToday(orderDetails)) {
      return res.status(400).json({
        success: false,
        message: "NDR action has already been raised for this shipment today.",
      });
    }

    // Standardize payload for runNdrTask
    const taskPayload = {
      ...req.body,
      remarks: req.body.remarks || req.body.comments || "Kindly Reattempt on priority basis.",
      comments: req.body.comments || req.body.remarks || "Kindly Reattempt on priority basis.",
      scheduledDate: req.body.scheduledDate || req.body.scheduled_delivery_date || req.body.next_attempt_date,
      phone: req.body.phone || req.body.mobile,
      address1: req.body.address1 || req.body.consignee_address,
    };

    const response = await runNdrTask(orderDetails._id, taskPayload);

    if (response.success) {
      return res.status(200).json({
        success: true,
        message: "NDR request processed successfully",
        data: response.data || response,
      });
    } else {
      console.warn(`External API NDR failed for ${awb_number}, queuing: ${response.message || response.error}`);

      // Sync with new workflow: Move to Action_Requested even if it failed and queued
      orderDetails.ndrStatus = "Action_Requested";
      orderDetails.status = "Action_Requested";
      if (!Array.isArray(orderDetails.ndrHistory)) orderDetails.ndrHistory = [];

      const queuedEntry = {
        action: req.body.action || "RE-ATTEMPT",
        actionBy: "Shiproxx",
        remark: taskPayload.remarks,
        source: "Shiproxx",
        date: new Date(),
      };
      orderDetails.ndrHistory.push({ actions: [queuedEntry] });
      await orderDetails.save();

      // Queue for 6 AM retry
      await FailedNdrAction.create({
        orderId: orderDetails._id,
        awb_number: awb_number,
        action: req.body.action || "RE-ATTEMPT",
        payload: taskPayload,
        lastError: response.message || response.error || "Initial API attempt failed",
        lastAttemptAt: new Date(),
        status: "failed",
      });

      return res.status(202).json({
        success: true,
        message: "NDR action received and queued for processing.",
        status: "Action_Requested"
      });
    }
  } catch (error) {
    console.error("Error in ndrCreate API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while processing NDR",
      error: error.message,
    });
  }
};

module.exports = { exceptionList, ndrCreate };
