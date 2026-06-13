if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const axios = require("axios");
const { getToken } = require("../Authorize/shreeMaruti.controller");
const mongoose = require("mongoose");
const Services = require("../../../models/CourierService.Schema");
const Order = require("../../../models/newOrder.model");
const { getUniqueId } = require("../../getUniqueId");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const user = require("../../../models/User.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const BASE_URL = process.env.SHREEMA_PRODUCTION_URL;

const getCourierList = async (req, res) => {
  try {
    const currCourier = await Courier.findOne({
      provider: "Shree Maruti",
    }).populate("services");
    const servicesData = currCourier.services;

    const allServices = servicesData.map((element) => ({
      service: element.courierProviderServiceName,
      isAdded: true,
    }));

    return res.status(201).json(allServices);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch courier list",
      details: error.response?.data || error.message,
    });
  }
};

const addService = async (req, res) => {
  try {
    const currCourier = await Courier.findOne({ provider: "ShreeMaruti" });

    const prevServices = new Set();
    const services = await Services.find({
      _id: { $in: currCourier.services },
    });

    services.forEach((service) => {
      prevServices.add(service.courierProviderServiceName);
    });

    const name = req.body.service;

    if (!prevServices.has(name)) {
      const newService = new Services({
        courierProviderServiceId: getUniqueId(),
        courierProviderServiceName: name,
        courierProviderName: "ShreeMaruti",
        createdName: req.body.name,
      });

      const S2 = await Courier.findOne({ provider: "ShreeMaruti" });
      S2.services.push(newService._id);

      await newService.save();
      await S2.save();

      // console.log(`New service saved: ${name}`);

      return res
        .status(201)
        .json({ message: `${name} has been successfully added` });
    }

    return res.status(400).json({ message: `${name} already exists` });
  } catch (error) {
    console.error(`Error adding service: ${error.message}`);
    res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
};

// Create Order
const createOrder = async (req, res) => {
  const API_URL = `${BASE_URL}/fulfillment/public/seller/order/ecomm/push-order`;
  const MANIFEST_API = `${BASE_URL}/fulfillment/public/seller/order/create-manifest`;
  const token = await getToken();
  const session = await mongoose.startSession();

  try {
    const {
      courierServiceName,
      id,
      provider,
      finalCharges,
      estimatedDeliveryDate,
      priceBreakup
    } = req.body;

    session.startTransaction();

    const services = await Services.findOne({
      name: courierServiceName,
    }).session(session);

    // Atomically lock order in transaction
    let currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session },
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Order is already being processed or not in 'new' status.",
      });
    }
    function sanitizeAddress(str) {
      return str
        .replace(/[^a-zA-Z\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    function normalizeState(state) {
      if (!state) return "";

      const cleaned = state
        .replace(/[^a-zA-Z\s]/g, "")
        .trim()
        .toLowerCase();

      if (
        cleaned === "jammu kashmir" ||
        cleaned === "jammu and kashmir" ||
        cleaned === "jammu  kashmir" ||
        cleaned === "jammu   kashmir"
      ) {
        return "Jammu and Kashmir";
      }

      return state.trim();
    }

    const users = await user
      .findById({ _id: currentOrder.userId })
      .session(session);
    const currentWallet = await Wallet.findById({ _id: users.Wallet }).select("balance holdAmount creditLimit").session(
      session,
    );
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode,
    );
    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + currentWallet.creditLimit;
    // Check wallet balance
    if (balance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    const lineItems = Array.from(
      { length: currentOrder.productDetails.length },
      (_, index) => {
        const item = currentOrder.productDetails[index];

        return {
          name: item.name,
          quantity: Number(item.quantity) || 0, // Ensure it's a number, default to 0 if invalid
          price: Number(item.unitPrice) * Number(item.quantity) || 0, // Ensure valid price
          unitPrice: Number(item.unitPrice) || 0, // Ensure valid unit price
          weight: currentOrder.packageDetails?.applicableWeight
            ? Math.max(
              Number(currentOrder.packageDetails.applicableWeight) * 1000,
              1,
            )
            : 1,
          sku: item.sku || null,
        };
      },
    );

    let payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "ONLINE";
    let payment_status =
      currentOrder.paymentDetails.method === "COD" ? "PENDING" : "PAID";

    const payload = {
      orderId: `${currentOrder.orderId}`,
      orderSubtype: "FORWARD",
      currency: "INR",
      amount: parseInt(currentOrder.paymentDetails.amount),
      weight: Number(currentOrder.packageDetails.applicableWeight) * 1000 || 1,
      lineItems: lineItems,
      paymentType: payment_type,
      paymentStatus: payment_status,
      length:
        Number(currentOrder.packageDetails?.volumetricWeight?.length) || 1,
      height:
        Number(currentOrder.packageDetails?.volumetricWeight?.height) || 1,
      width: Number(currentOrder.packageDetails?.volumetricWeight?.width) || 1,

      billingAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: sanitizeAddress(currentOrder.pickupAddress.address),
        // address2: currentOrder.Biling_details.address2,
        city: currentOrder.pickupAddress.city,
        state: normalizeState(currentOrder.pickupAddress.state),
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      shippingAddress: {
        name: `${currentOrder.receiverAddress.contactName}`,
        phone: currentOrder.receiverAddress.phoneNumber.toString(),
        address1: sanitizeAddress(currentOrder.receiverAddress.address),
        // address2: currentOrder.receiverAddress.address2,
        city: currentOrder.receiverAddress.city,
        state: normalizeState(currentOrder.receiverAddress.state),
        country: "India",
        zip: `${currentOrder.receiverAddress.pinCode}`,
      },
      pickupAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: sanitizeAddress(currentOrder.pickupAddress.address),
        // address2: wh.addressLine2,
        city: currentOrder.pickupAddress.city,
        state: normalizeState(currentOrder.pickupAddress.state),
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      returnAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: currentOrder.pickupAddress.address,
        // address2: wh.addressLine2,
        city: currentOrder.pickupAddress.city,
        state: normalizeState(currentOrder.pickupAddress.state),
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      selectedCarriers: [
        {
          shortName: "SMILE",
        },
      ],
      deliveryPromise:
        services.courierType === "Domestic (Surface)" ? "SURFACE" : "AIR",
    };

    // const effectiveBalance =
    //   currentWallet.balance - (currentWallet.holdAmount || 0);
    // const balance = effectiveBalance + currentWallet.creditLimit;
    // if (balance < finalCharges) {
    //   return res
    //     .status(400)
    //     .json({ success: false, message: "Insufficient Wallet Balance" });
    // }

    // console.log("Payload for Shipment API:", payload);

    // --- Call Shipment API ---
    let response;
    try {
      response = await axios.post(API_URL, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (shipmentErr) {
      await session.abortTransaction();
      session.endSession();
      console.error(
        "Shipment API failed:",
        shipmentErr.response?.data || shipmentErr.message,
      );
      return res.status(500).json({
        error: "Shipment creation failed",
        details: shipmentErr.response?.data || shipmentErr.message,
      });
    }

    if (response.status == 200) {
      const result = response.data.data;

      // Update order and wallet inside transaction
      currentOrder.status = "Booked";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awbNumber;
      currentOrder.shipment_id = `${result.shipperOrderId}`;
      currentOrder.provider = provider;
      currentOrder.totalFreightCharges = parseFloat(finalCharges);
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.estimatedDeliveryDate = estimatedDeliveryDate;
      currentOrder.zone = zone.zone;
      currentOrder.priceBreakup = priceBreakup;
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        Instructions: "Order booked successfully",
      });

      await currentOrder.save({ session });

      const balanceToBeDeducted = parseFloat(finalCharges);
      await currentWallet.updateOne(
        {
          $inc: { balance: -balanceToBeDeducted },
        },
        { session },
      );

      // 🔁 Dual-write: mirror to WalletTransaction for future migration
      await WalletTransaction.create([{
        walletId: currentWallet._id,
        channelOrderId: currentOrder.orderId || null,
        category: "debit",
        amount: balanceToBeDeducted,
        balanceAfterTransaction: currentWallet.balance - balanceToBeDeducted,
        date: new Date(),
        awb_number: result.awbNumber || "",
        description: "Freight Charges Applied",
        priceBreakup
      }], { session });

      await session.commitTransaction();
      session.endSession();

      // ── Auto-assign pickup manifest ──
      try {
        const freshOrder = await Order.findById(id);
        if (freshOrder) await assignPickupManifest(freshOrder);
      } catch (pErr) {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      }

      // Call Manifest API outside transaction
      try {
        const manifestResponse = await axios.post(
          MANIFEST_API,
          {
            awbNumber: [result.awbNumber],
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          },
        );
        console.log("Manifest Created:", manifestResponse.data);
      } catch (manifestErr) {
        console.error(
          "Error creating manifest:",
          manifestErr.response?.data || manifestErr.message,
        );
      }

      return res
        .status(201)
        .json({
          success: true,
          message: "Shipment & Manifest Created Successfully",
          awb_number: result.awbNumber,
          orderId: currentOrder.orderId,
        });
    } else {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ error: "Error creating shipment", details: response.data });
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error("Error:", error.response?.data || error.message);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
};

// Cancel Order
const cancelOrderShreeMaruti = async (order_Id) => {
  const payload = {
    orderId: `${order_Id}`,
    cancelReason: "Cancel by customer",
  };

  try {
    const token = await getToken();

    const response = await axios.put(
      `${BASE_URL}/fulfillment/public/seller/order/cancel-order`,
      payload,
      {
        headers: {
          "Content-Type": "application/json", // Fixed header
          Authorization: `Bearer ${token}`, // Token added
        },
      },
    );

    console.log("Response:", response);

    if (response.status === 200) {
      // await Order.updateOne(
      //   { orderId: order_Id },
      //   { $set: { status: "Cancelled" } }
      // );
      // Correct status check
      return {
        success: true,
        data: response.data,
      };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: response.status,
        success: false,
      };
    }
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    return {
      error: "Internal Server Error",
      message: error.response?.data || error.message,
      code: error.response?.status || 500,
      success: false,
    };
  }
};

// Download Label and Invoice
const downloadLabelInvoice = async (req, res) => {
  const { awbNumber, cAwbNumber } = req.query; // Extracting query parameters

  if (!awbNumber || !cAwbNumber) {
    return res
      .status(400)
      .json({ error: "awbNumber and cAwbNumber are required" });
  }

  try {
    const response = await axios.get(
      `${BASE_URL}/fulfillment/public/seller/order/download/label-invoice`,
      {
        params: { awbNumber, cAwbNumber }, // Passing query parameters
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    res.status(200).json(response.data);
  } catch (error) {
    console.error(
      "Error downloading label/invoice:",
      error.response?.data || error.message,
    );
    res.status(500).json({
      error: "Download failed",
      details: error.response?.data || error.message,
    });
  }
};

// Create Manifest
const createManifest = async (req, res) => {
  // console.log("Request Body:", req.body);

  // Extract the AWB numbers from the request body keys
  const awbNumbers = Object.keys(req.body); // Converts { '56050528810081': '' } to ['56050528810081']

  // Construct the payload with the required structure
  const payload = {
    awbNumber: awbNumbers, // Ensure awbNumber is an array
    // cAwbNumber: [] // If needed, otherwise remove this field
  };

  try {
    const token = await getToken();
    // console.log(token,"hhhhhhhhhh",awbNumbers)// Ensure token is fetched correctly
    const response = await axios.post(
      `${BASE_URL}/fulfillment/public/seller/order/create-manifest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );
    console.log("jkkkkkkkkkkkkk", response.data);

    res.status(200).json(response.data);
  } catch (error) {
    console.error(
      "Error creating manifest:",
      error.response?.data || error.message,
    );
    res.status(500).json({
      error: "Manifest creation failed",
      details: error.response?.data || error.message,
    });
  }
};

// Track Order
const trackOrderShreeMaruti = async (awbNumber) => {
  // console.log("awbNumber",awbNumber)
  if (!awbNumber) {
    return {
      success: false,
      data: "Waybill number is required",
    };
  }
  const token = await getToken();
  // console.log("tokennnnnnn", token);
  try {
    const response = await axios.get(`${BASE_URL}/tracking/v2/${awbNumber}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log("ressssssss", response.data);

    return {
      success: true,
      data: (response.data.statuses || []).reverse(),
    };
  } catch (error) {
    console.error(
      "Error tracking order:",
      error.response?.data || error.message,
    );
    // console.log(error);

    return {
      success: false,
      data: "Error in tracking",
    };
  }
};
// trackOrderShreeMaruti("SHIP40000004132");

// Serviceability
const checkServiceabilityShreeMaruti = async (payload) => {
  const { fromPincode, toPincode, isCodOrder, deliveryMode } = payload;
  if (!fromPincode || !toPincode || isCodOrder === undefined || !deliveryMode) {
    return {
      error:
        "Missing required fields: fromPincode, toPincode, isCodOrder, and deliveryMode are mandatory.",
    };
  }
  // console.log("payload")
  try {
    const token = await getToken();
    const response = await axios.post(
      `${BASE_URL}/fulfillment/public/seller/order/check-ecomm-order-serviceability`,
      { fromPincode, toPincode, isCodOrder, deliveryMode },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );

    // console.log("shreemaruti",response.data)

    if (response && response.data && response.data.data) {
      if (response.data.data.serviceability) {
        return { success: true };
      } else {
        return { success: false };
      }
    } else {
      // console.error("Unexpected response structure:", response);
      return { success: false };
    }
  } catch (error) {
    if (error.response) {
      console.error("API error response:", error.response.data);
      return { success: false };
    } else {
      // console.error("Request error:", error.message);
      return { success: false };
    }
    return { success: false };
  }
};

module.exports = {
  createOrder,
  cancelOrderShreeMaruti,
  downloadLabelInvoice,
  createManifest,
  trackOrderShreeMaruti,
  checkServiceabilityShreeMaruti,
  getCourierList,
  addService,
};
