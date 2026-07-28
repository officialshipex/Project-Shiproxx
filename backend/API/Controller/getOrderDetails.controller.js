const Order = require("../../models/newOrder.model");

const getOrderDetails = async (req, res) => {
  try {
    const userId = req.user._id;
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        status: "failure",
        message: "Order ID is required as a route parameter.",
      });
    }

    // Since orderId is stored as a Number in DB, we try to convert it.
    const numericOrderId = Number(orderId);
    if (isNaN(numericOrderId)) {
      return res.status(400).json({
        status: "failure",
        message: "Order ID must be a numeric value.",
      });
    }

    // Find the order that belongs to this user
    const order = await Order.findOne({ orderId: numericOrderId, userId });

    if (!order) {
      return res.status(404).json({
        status: "failure",
        message: `Order with ID ${orderId} not found.`,
      });
    }

    // Send only the required details
    return res.status(200).json({
      status: "success",
      data: {
        orderId: order.orderId,
        clientOrderId: order.channelId || null,
        awb_number: order.awb_number || null,
        status: order.status,
        provider: order.provider || null,
        courierServiceName: order.courierServiceName || null,
        paymentDetails: order.paymentDetails,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
    });
  } catch (err) {
    console.error("Error retrieving order details:", err);
    return res.status(500).json({
      status: "failure",
      message: "Internal Server Error",
    });
  }
};

module.exports = getOrderDetails;
