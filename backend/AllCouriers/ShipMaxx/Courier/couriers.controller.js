const axios = require("axios");
const { getShipMaxxToken, SHIPMAXX_BASE_URL } = require("../Authorize/shipmaxx.controller");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const CourierService = require("../../../models/CourierService.Schema");
const createShipMaxxShipment = require("../../../API/Courier/shipmaxxShipmentCreation.controller");

const checkServiceabilityShipMaxx = async ({
  pickupPincode,
  deliveryPincode,
  weight,
  paymentMode, // "cod" | "prepaid"
  shipmentValue,
}) => {
  try {
    const token = await getShipMaxxToken();
    if (!token) {
      return { success: false, message: "ShipMaxx auth token retrieval failed" };
    }

    const response = await axios.post(
      `${SHIPMAXX_BASE_URL}/shipping/serviceability`,
      {
        source_pincode: String(pickupPincode),
        destination_pincode: String(deliveryPincode),
        weight_kg: Number(weight) || 0.5,
        payment_type: paymentMode === "cod" ? "cod" : "prepaid",
        shipment_type: "forward",
        shipment_value: Number(shipmentValue) || 0,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    if (Array.isArray(response.data)) {
      return { success: true, data: response.data };
    }
    return { success: false, message: "No serviceability data returned" };
  } catch (error) {
    console.error("ShipMaxx Serviceability Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data?.detail || error.message };
  }
};

const createOrder = async (req, res) => {
  try {
    const {
      id,
      finalCharges,
      courierServiceName,
      priceBreakup,
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

    // 3. Fetch specific carrier variant id (ShipMaxx's `carrier_id`, stored on
    // CourierService.courier — the same value serviceability results match on)
    const courierService = await CourierService.findOne({
      name: courierServiceName,
      provider: "ShipMaxx",
    });

    const carrierVariantId = courierService ? courierService.courier : null;

    // 4. Delegate to transaction booking helper
    const result = await createShipMaxxShipment({
      id,
      provider: "ShipMaxx",
      finalCharges,
      courierServiceName,
      carrierVariantId,
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
        provider: "ShipMaxx",
        awb_number: result.awb_number,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: result.message || "Failed to create shipment",
      });
    }
  } catch (error) {
    console.error("ShipMaxx UI Shipment Creation Error:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create order.",
      error: error.message,
    });
  }
};

const trackOrderShipMaxx = async (awb) => {
  try {
    const token = await getShipMaxxToken();
    if (!token) {
      return { success: false, message: "ShipMaxx auth token retrieval failed" };
    }

    const response = await axios.get(`${SHIPMAXX_BASE_URL}/shipping/track-shipment`, {
      params: { awb },
      headers: {
        Authorization: `Bearer ${token}`,
      },
      timeout: 10000,
    });

    if (response.data) {
      return { success: true, data: response.data };
    }

    return { success: false, message: "No data returned from tracking API" };
  } catch (error) {
    console.error("ShipMaxx Tracking Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data?.detail || error.message };
  }
};

const cancelOrderShipMaxx = async (awb) => {
  try {
    const token = await getShipMaxxToken();
    if (!token) {
      return { success: false, message: "ShipMaxx auth token retrieval failed" };
    }

    const response = await axios.post(
      `${SHIPMAXX_BASE_URL}/shipping/cancel-shipment`,
      {
        awb: awb,
        cancellation_reason: "Customer requested",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    if (response.data && response.data.success) {
      return { success: true, message: response.data.message || "Cancelled successfully", data: response.data };
    }

    return { success: false, message: response.data?.message || "Cancellation failed at ShipMaxx" };
  } catch (error) {
    console.error("ShipMaxx Cancellation Error:", error.response?.data || error.message);
    return {
      success: false,
      message: error.response?.data?.message || error.response?.data?.detail || error.message,
      error: error.response?.data || error.message,
    };
  }
};

const getShipMaxxNdrList = async (req, res) => {
  try {
    const token = await getShipMaxxToken();
    if (!token) {
      return res.status(401).json({ success: false, message: "ShipMaxx authentication failed" });
    }

    const response = await axios.get(`${SHIPMAXX_BASE_URL}/ndr`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        status: req.query.status,
      },
      timeout: 10000,
    });

    return res.status(200).json(response.data);
  } catch (error) {
    console.error("ShipMaxx NDR List Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch ShipMaxx NDR List",
      error: error.response?.data || error.message,
    });
  }
};

module.exports = {
  checkServiceabilityShipMaxx,
  createOrder,
  trackOrderShipMaxx,
  cancelOrderShipMaxx,
  getShipMaxxNdrList,
};
