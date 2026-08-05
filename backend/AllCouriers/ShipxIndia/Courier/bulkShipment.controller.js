const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const { getShipexToken } = require("../Authorize/shipxIndia.controller");

const createShipmentFunctionShipexIndia = async (
  selectedServiceDetails,
  id,
  wh,
  walletId,
  finalCharges,
  priceBreakup
) => {
  try {
    const currentOrder = await Order.findById(id);
    if (!currentOrder) return { status: 404, message: "Order not found" };

    const token = await getShipexToken();
    if (!token) return { status: 401, message: "ShipexIndia API Token not found" };

    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    // Wallet check with credit limit
    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const totalBalance = effectiveBalance + (currentWallet.creditLimit || 0);

    if (totalBalance < finalCharges) {
      return { status: 400, success: false, message: "Insufficient Wallet Balance" };
    }

    const user = await User.findById(currentOrder.userId);
    if (!user) return { status: 404, message: "User not found" };

    // Prepare Payload
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

    console.log("ShipexIndia Bulk Create Order Payload:", JSON.stringify(shipexPayload, null, 2));

    // Step 1: Create Order in ShipexIndia
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

    console.log("ShipexIndia Bulk Create Order Response:", createResponse.data);

    if (!createResponse.data || !createResponse.data.success || !createResponse.data.data?.orderId) {
      return { status: 400, success: false, message: createResponse.data?.message || "ShipexIndia order creation failed" };
    }

    const shipexOrderId = createResponse.data.data.orderId;

    const targetServiceName = selectedServiceDetails.name || selectedServiceDetails.courierServiceName || "";
    let shipexCourierName = targetServiceName;
    let shipexCourierId = "";

    try {
      const CourierService = require("../../../models/CourierService.Schema");
      const serviceDoc = await CourierService.findOne({ name: targetServiceName, provider: "ShipexIndia" });
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

    // Step 2: Book the order (Order Booking)
    const bookingPayload = {
      orderId: String(shipexOrderId),
      courierServiceName: shipexCourierName,
      courierId: shipexCourierId,
    };

    console.log("ShipexIndia Bulk Booking Payload:", bookingPayload);

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

    console.log("ShipexIndia Bulk Booking Response:", bookingResponse.data);

    if (
      !bookingResponse.data ||
      bookingResponse.data.status !== "success" ||
      !bookingResponse.data.data?.awb_number
    ) {
      return { status: 400, success: false, message: bookingResponse.data?.message || "ShipexIndia order booking failed" };
    }

    const { awb_number, labelUrl } = bookingResponse.data.data;

    // Update Order in DB
    currentOrder.status = "Booked";
    currentOrder.awb_number = awb_number;
    currentOrder.label = labelUrl || "";
    const providerWord = shipexCourierName.split(" ")[0];
    currentOrder.provider = providerWord;
    currentOrder.partner = "ShipexIndia";
    currentOrder.shipment_id = String(shipexOrderId);
    currentOrder.totalFreightCharges = parseFloat(finalCharges) || 0;
    currentOrder.courierServiceName = selectedServiceDetails.name;
    currentOrder.zone = zone?.zone;
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city,
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    // Update Wallet balance
    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: walletId },
      {
        $inc: { balance: -parseFloat(finalCharges) },
      },
      { new: true }
    );

    if (updatedWallet) {
      await WalletTransaction.create({
        walletId: updatedWallet._id,
        channelOrderId: currentOrder.orderId,
        category: "debit",
        amount: parseFloat(finalCharges),
        balanceAfterTransaction: updatedWallet.balance,
        awb_number: awb_number,
        description: "Freight Charges Applied",
        priceBreakup,
      });
    }

    await currentOrder.save();

    // Auto-assign pickup manifest
    try {
      await assignPickupManifest(currentOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    return { status: 201, success: true, message: "Shipment Created Successfully", awb: awb_number };
  } catch (error) {
    console.error("ShipexIndia Bulk Shipment Error:", error.response?.data || error.message);
    return { status: 500, success: false, message: error.message };
  }
};

module.exports = { createShipmentFunctionShipexIndia };
