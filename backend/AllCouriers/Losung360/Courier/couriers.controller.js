const axios = require("axios");
const { getLosung360AccessToken } = require("../Authorize/losung360.controller");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const CourierService = require("../../../models/CourierService.Schema");
const createLosung360Shipment = require("../../../API/Courier/losung360ShipmentCreation.controller");

const LOSUNG360_BASE_URL = "https://appapi.losung360.com/external/v1";

const createOrder = async (req, res) => {
  try {
    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      estimatedDeliveryDate,
      priceBreakup
    } = req.body;

    // 1. Fetch order details
    const currentOrder = await Order.findById(id);
    if (!currentOrder) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // 2. Fetch user wallet
    const userInstance = await User.findById(currentOrder.userId).populate("Wallet");
    if (!userInstance || !userInstance.Wallet) {
      return res.status(400).json({ success: false, message: "User or Wallet not found" });
    }

    const wallet = userInstance.Wallet;

    // 3. Fetch specific partner service variant
    const courierService = await CourierService.findOne({
      name: courierServiceName,
      provider: "Losung360",
    });

    const partnerServiceId = courierService ? courierService.courier_id : null;

    // 4. Delegate to transaction booking helper
    const result = await createLosung360Shipment({
      id,
      provider: "Losung360",
      finalCharges,
      courierServiceName,
      partnerServiceId,
      priceBreakup,
      userId: currentOrder.userId,
      walletId: wallet._id,
      walletBalance: wallet.balance,
      walletHoldAmount: wallet.holdAmount || 0,
      walletCreditLimit: wallet.creditLimit || 0,
    });

    if (result.success) {
      return res.status(201).json({
        success: true,
        message: "Shipment Created Successfully",
        orderId: currentOrder.orderId,
        provider: "Losung360",
        awb_number: result.awb_number,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: result.message || "Failed to create shipment",
      });
    }
  } catch (error) {
    console.error("Losung360 UI Shipment Creation Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to create order.",
      error: error.message,
    });
  }
};

const trackLosung360Order = async (awb) => {
  try {
    const token = await getLosung360AccessToken();
    if (!token) {
      return { success: false, message: "Losung360 auth token retrieval failed" };
    }

    const response = await axios.get(
      `${LOSUNG360_BASE_URL}/shipping/track-shipment`,
      {
        params: { awb },
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 10000
      }
    );

    if (response.data) {
      // console.log("Losung360 Tracking Response Data:", JSON.stringify(response.data, null, 2));
      return { success: true, data: response.data };
    }

    return { success: false, message: "No data returned from tracking API" };
  } catch (error) {
    console.error("Losung360 Tracking Error:", error?.response?.data || error.message);
    return { success: false, error: error?.response?.data?.detail || error.message };
  }
};
// trackLosung360Order("77836708294")
//   .then(res => console.log("Top-level Track Call Result:", JSON.stringify(res, null, 2)))
//   .catch(err => console.error("Top-level Track Call Error:", err));

const cancelLosung360Order = async (awb) => {
  return { success: true };
};

module.exports = { trackLosung360Order, createOrder, cancelLosung360Order };

