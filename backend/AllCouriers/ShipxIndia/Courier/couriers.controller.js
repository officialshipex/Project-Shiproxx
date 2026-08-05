const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const { getShipexToken } = require("../Authorize/shipxIndia.controller");

const shipexServiceabilityCache = new Map();

const checkShipexIndiaServiceability = async (payload) => {
  const cacheKey = `${payload.pickUpPincode || payload.fromPincode}-${payload.deliveryPincode || payload.toPincode}-${payload.applicableWeight || payload.order_weight || 0.5}-${payload.paymentType === "COD" || payload.isCodOrder ? "COD" : "Prepaid"}`;

  if (shipexServiceabilityCache.has(cacheKey)) {
    return shipexServiceabilityCache.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const token = await getShipexToken();
      if (!token) return { success: false, message: "Auth failed", data: [] };

      const response = await axios.post(
        "https://api.shipexindia.com/v1/api/external/pincodeServiceability",
        {
          pickUpPincode: String(payload.pickUpPincode || payload.fromPincode),
          deliveryPincode: String(payload.deliveryPincode || payload.toPincode),
          applicableWeight: Number(payload.applicableWeight || payload.order_weight || 0.5),
          length: Number(payload.length || 10),
          width: Number(payload.width || 10),
          height: Number(payload.height || 10),
          paymentType: payload.paymentType === "COD" || payload.isCodOrder ? "COD" : "Prepaid",
          declaredValue: Number(payload.declaredValue || payload.order_value || 0),
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
        }
      );

      if (response.data && (response.data.status === "success" || response.data.success === true || response.data.serviceable === true)) {
        return { success: true, data: response.data.data || [] };
      }
      return { success: false, message: response.data?.message || "Not serviceable", data: [] };
    } catch (error) {
      console.error("ShipexIndia Serviceability Error:", error.response?.data || error.message);
      return { success: false, error: error.message, data: [] };
    }
  })();

  shipexServiceabilityCache.set(cacheKey, promise);

  // Clear cache entry after 10 seconds (transient cache for concurrent checks)
  setTimeout(() => {
    shipexServiceabilityCache.delete(cacheKey);
  }, 10000);

  return promise;
};

const createShipexIndiaShipment = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      id,
      finalCharges,
      courierServiceName,
      priceBreakup,
      estimatedDeliveryDate,
    } = req.body;

    session.startTransaction();

    // 1. Lock the order
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Shipment already created or order is being processed.",
      });
    }

    // 2. Fetch User and Wallet
    const user = await User.findById(currentOrder.userId).session(session);
    if (!user) throw new Error("User not found");

    const currentWallet = await Wallet.findById(user.Wallet)
      .select("balance holdAmount creditLimit")
      .session(session);
    if (!currentWallet) throw new Error("Wallet not found");

    // 3. Balance Check
    const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0);
    const totalBalance = effectiveBalance + (currentWallet.creditLimit || 0);
    if (totalBalance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      await Order.findByIdAndUpdate(id, { status: "new" });
      return res.status(400).json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // 4. Get Zone
    const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      await Order.findByIdAndUpdate(id, { status: "new" });
      return res.status(400).json({ success: false, message: "Pincode not serviceable" });
    }

    // 5. Authenticate with ShipexIndia
    const token = await getShipexToken();
    if (!token) throw new Error("ShipexIndia authentication failed");

    // 6. Map Order Details Payload for ShipexIndia
    const shipexPayload = {
      shipmentId: Number(currentOrder.orderId),
      pickupAddress: {
        contactName: currentOrder.pickupAddress.contactName,
        email: currentOrder.pickupAddress.email || user.email || "info@shiproxx.com",
        phoneNumber: String(currentOrder.pickupAddress.phoneNumber),
        address: currentOrder.pickupAddress.address,
        pinCode: String(currentOrder.pickupAddress.pinCode),
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
      },
      receiverAddress: {
        contactName: currentOrder.receiverAddress.contactName,
        email: currentOrder.receiverAddress.email || "info@shiproxx.com",
        phoneNumber: String(currentOrder.receiverAddress.phoneNumber),
        address: currentOrder.receiverAddress.address,
        pinCode: String(currentOrder.receiverAddress.pinCode),
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
      },
      productDetails: currentOrder.productDetails.map((item) => ({
        id: String(item.id),
        quantity: Number(item.quantity) || 1,
        name: item.name || "Product",
        sku: item.sku || String(item.id),
        unitPrice: String(item.unitPrice || 0),
      })),
      packageDetails: {
        deadWeight: Number(currentOrder.packageDetails?.deadWeight) || 0.5,
        applicableWeight: Number(currentOrder.packageDetails?.applicableWeight) || 0.5,
        volumetricWeight: {
          length: Number(currentOrder.packageDetails?.volumetricWeight?.length) || 10,
          width: Number(currentOrder.packageDetails?.volumetricWeight?.width) || 10,
          height: Number(currentOrder.packageDetails?.volumetricWeight?.height) || 10,
          calculatedWeight: Number(currentOrder.packageDetails?.volumetricWeight?.calculatedWeight) || 0.5,
        },
      },
      paymentDetails: {
        method: currentOrder.paymentDetails?.method === "COD" ? "COD" : "Prepaid",
        amount: Number(currentOrder.paymentDetails?.amount) || 0,
      },
    };

    console.log("ShipexIndia Create Order Payload:", JSON.stringify(shipexPayload, null, 2));

    // 7. Step 1: Create Order in ShipexIndia
    const createResponse = await axios.post(
      "https://api.shipexindia.com/v1/api/external/createOrder",
      shipexPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    console.log("ShipexIndia Create Order Response:", createResponse.data);

    if (!createResponse.data || !createResponse.data.success || !createResponse.data.data?.orderId) {
      throw new Error(createResponse.data?.message || "ShipexIndia order creation failed");
    }

    const shipexOrderId = createResponse.data.data.orderId;

    let shipexCourierName = courierServiceName;
    let shipexCourierId = "";

    try {
      const CourierService = require("../../../models/CourierService.Schema");
      const serviceDoc = await CourierService.findOne({ name: courierServiceName, provider: "ShipexIndia" });
      if (serviceDoc) {
        shipexCourierName = serviceDoc.courier || serviceDoc.name;
        shipexCourierId = serviceDoc.courier_id;
      }
    } catch (dbErr) {
      console.error("Error fetching CourierService details from DB:", dbErr.message);
    }

    if (!shipexCourierId) {
      const nameLower = String(shipexCourierName).toLowerCase();
      if (nameLower.includes("delhivery")) shipexCourierId = "02";
      else if (nameLower.includes("dtdc")) shipexCourierId = "03";
      else if (nameLower.includes("bluedart")) shipexCourierId = "13";
      else if (nameLower.includes("amazon")) shipexCourierId = "05";
      else if (nameLower.includes("maruti")) shipexCourierId = "06";
      else if (nameLower.includes("ekart")) shipexCourierId = "08";
      else if (nameLower.includes("xpressbees")) shipexCourierId = "09";
      else if (nameLower.includes("shadowfax")) shipexCourierId = "12";
      else shipexCourierId = "02";
    }

    // 8. Step 2: Book the order (Order Booking)
    const bookingPayload = {
      orderId: String(shipexOrderId),
      courierServiceName: shipexCourierName,
      courierId: shipexCourierId,
    };

    console.log("ShipexIndia Booking Payload:", bookingPayload);

    const bookingResponse = await axios.post(
      "https://api.shipexindia.com/v1/api/external/orderBooking",
      bookingPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 12000,
      }
    );

    console.log("ShipexIndia Booking Response:", bookingResponse.data);

    if (
      !bookingResponse.data ||
      bookingResponse.data.status !== "success" ||
      !bookingResponse.data.data?.awb_number
    ) {
      throw new Error(bookingResponse.data?.message || "ShipexIndia order booking failed");
    }

    const { awb_number, labelUrl } = bookingResponse.data.data;

    // 10. Update Order in DB
    currentOrder.status = "Booked";
    currentOrder.awb_number = awb_number;
    currentOrder.label = labelUrl || "";
    const providerWord = shipexCourierName.split(" ")[0];
    currentOrder.provider = providerWord;
    currentOrder.partner = "ShipexIndia";
    currentOrder.shipment_id = String(shipexOrderId);
    currentOrder.totalFreightCharges = parseFloat(finalCharges) || 0;
    currentOrder.courierServiceName = courierServiceName;
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || "";
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city,
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    // 11. Update Wallet inside transaction
    currentWallet.balance -= finalCharges;
    await WalletTransaction.create(
      [
        {
          walletId: currentWallet._id,
          channelOrderId: currentOrder.orderId,
          category: "debit",
          amount: finalCharges,
          balanceAfterTransaction: currentWallet.balance,
          awb_number: awb_number,
          description: "Freight Charges Applied",
          priceBreakup,
        },
      ],
      { session }
    );

    await Promise.all([
      currentOrder.save({ session }),
      currentWallet.save({ session }),
    ]);

    await session.commitTransaction();
    session.endSession();

    // Auto-assign pickup manifest
    try {
      const freshOrder = await Order.findById(id);
      if (freshOrder) await assignPickupManifest(freshOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      awb_number: awb_number,
      orderId: currentOrder.orderId,
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();

    if (req.body.id) {
      await Order.updateOne(
        { _id: req.body.id, status: "processing" },
        { $set: { status: "new" } }
      );
    }

    console.error("ShipexIndia Order Creation/Booking Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data?.message || error.message,
    });
  }
};

const cancelShipexIndiaOrder = async (awb) => {
  try {
    const token = await getShipexToken();
    if (!token) return { success: false, message: "Auth failed" };

    const response = await axios.post(
      `https://api.shipexindia.com/v1/api/external/cancelledOrder/${awb}`,
      {},
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000,
      }
    );

    if (response.data && response.data.success) {
      return { success: true, message: "Cancelled successfully via ShipexIndia" };
    }
    return { success: false, error: response.data?.message || "Cancellation failed" };
  } catch (error) {
    console.error("ShipexIndia Cancellation Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error || error.message };
  }
};

const getShipexNdrList = async (req, res) => {
  try {
    const token = await getShipexToken();
    if (!token) return res.status(401).json({ success: false, message: "Auth failed" });

    const response = await axios.get(
      "https://api.shipexindia.com/v1/api/external/exceptionList",
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000,
      }
    );

    return res.status(200).json(response.data);
  } catch (error) {
    console.error("ShipexIndia NDR List Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch ShipexIndia NDR List",
      error: error.response?.data || error.message,
    });
  }
};

module.exports = {
  createShipexIndiaShipment,
  checkShipexIndiaServiceability,
  cancelShipexIndiaOrder,
  getShipexNdrList,
};
