if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const { getAuthToken } = require("../Authorize/shiprocket.controller");
const { addPickupLocation, requestShipmentPickup } = require("./couriers.controller");
const axios = require("axios");

const BASE_URL = `${process.env.SHIPROCKET_URL}/v1/external`;
const SHIPROCKET_EMAIL = process.env.SHIPR_GMAIL;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getCurrentDateTime = () => {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${date} ${hours}:${minutes}`;
};

const generateSKU = (name) => {
  const clean = (name || "PROD").replace(/[^a-zA-Z0-9]/g, "").substring(0, 5).toUpperCase();
  return `${clean}${Math.floor(1000 + Math.random() * 9000)}`;
};

const cleanPhone = (phone) => {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const splitName = (fullName) => {
  const parts = (fullName || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "." };
};

// ─── Internal: Assign AWB ─────────────────────────────────────────────────────
const assignAWB = async (token, shipment_id, courier_id) => {
  try {
    const response = await axios.post(
      `${BASE_URL}/courier/assign/awb`,
      { shipment_id, courier_id },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 15000,
      }
    );
    return response.data?.response?.data || null;
  } catch (error) {
    console.error("ShipRocket assignAWB (bulk) Error:", error.response?.data || error.message);
    return null;
  }
};

// ─── Bulk Booking ─────────────────────────────────────────────────────────────
const createShipmentFunctionShipRocket = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  finalCharges,
  priceBreakup,
  estimatedDeliveryDate = null
) => {
  try {
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) return { status: 404, error: "Order not found" };

    const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
    if (!zone) return { status: 400, error: "Pincode not serviceable" };

    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (!currentWallet) return { status: 404, error: "Wallet not found" };

    const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0) + (currentWallet.creditLimit || 0);
    const charges = parseFloat(finalCharges) || 0;
    if (effectiveBalance < charges) return { status: 400, error: "Insufficient Wallet Balance" };

    const token = await getAuthToken();
    if (!token) return { status: 500, error: "ShipRocket authentication failed" };

    const pickupLocationName = wh?.warehouseName || currentOrder.pickupAddress.contactName;
    await addPickupLocation({
      warehouseName: pickupLocationName,
      contactName: currentOrder.pickupAddress.contactName,
      email: currentOrder.pickupAddress.email || SHIPROCKET_EMAIL,
      phoneNumber: currentOrder.pickupAddress.phoneNumber,
      address: currentOrder.pickupAddress.address,
      city: currentOrder.pickupAddress.city,
      state: currentOrder.pickupAddress.state,
      pinCode: currentOrder.pickupAddress.pinCode,
    });

    const senderName = splitName(currentOrder.pickupAddress.contactName);
    const receiverName = splitName(currentOrder.receiverAddress.contactName);
    const isCOD = currentOrder.paymentDetails.method === "COD";
    const provider_courier_id = serviceDetails.provider_courier_id;

    const order_items = currentOrder.productDetails.map((p) => ({
      name: p.name || "Product",
      sku: p.sku || generateSKU(p.name),
      units: Number(p.quantity) || 1,
      selling_price: parseFloat(p.unitPrice) || 0,
    }));

    const shipmentPayload = {
      order_id: String(currentOrder.orderId),
      order_date: getCurrentDateTime(),
      pickup_location: pickupLocationName,
      billing_customer_name: senderName.first,
      billing_last_name: senderName.last,
      billing_address: currentOrder.pickupAddress.address,
      billing_city: currentOrder.pickupAddress.city,
      billing_pincode: String(currentOrder.pickupAddress.pinCode),
      billing_state: currentOrder.pickupAddress.state,
      billing_country: "India",
      billing_email: currentOrder.pickupAddress.email || user.email || SHIPROCKET_EMAIL,
      billing_phone: cleanPhone(currentOrder.pickupAddress.phoneNumber),
      shipping_is_billing: false,
      shipping_customer_name: receiverName.first,
      shipping_last_name: receiverName.last,
      shipping_address: currentOrder.receiverAddress.address,
      shipping_city: currentOrder.receiverAddress.city,
      shipping_pincode: String(currentOrder.receiverAddress.pinCode),
      shipping_state: currentOrder.receiverAddress.state,
      shipping_country: "India",
      shipping_email: currentOrder.receiverAddress.email || SHIPROCKET_EMAIL,
      shipping_phone: cleanPhone(currentOrder.receiverAddress.phoneNumber),
      order_items,
      payment_method: isCOD ? "COD" : "Prepaid",
      sub_total: currentOrder.paymentDetails.amount,
      length: currentOrder.packageDetails.volumetricWeight?.length || 10,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 10,
      height: currentOrder.packageDetails.volumetricWeight?.height || 10,
      weight: currentOrder.packageDetails.applicableWeight || 0.5,
    };

    const orderResponse = await axios.post(`${BASE_URL}/orders/create/adhoc`, shipmentPayload, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 20000,
    });

    if (!orderResponse.data?.shipment_id) return { status: 400, error: orderResponse.data?.message || "Order creation failed" };
    const { shipment_id } = orderResponse.data;
    const awbResult = await assignAWB(token, shipment_id, provider_courier_id);
    if (!awbResult?.awb_code) return { status: 400, error: "Failed to assign AWB" };

    const awb_number = awbResult.awb_code;
    const courier_name = awbResult.courier_name || null;
    currentOrder.status = "Booked";
    currentOrder.awb_number = awb_number;
    currentOrder.shipment_id = String(shipment_id);
    currentOrder.provider = courier_name || "Shiprocket";
    currentOrder.partner = "Shiprocket";
    currentOrder.totalFreightCharges = charges;
    currentOrder.courierServiceName = serviceDetails.name || serviceDetails.courierProviderServiceName;
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || null;
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city || "N/A",
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    await currentOrder.save();
    process.nextTick(async () => {
      try { await requestShipmentPickup(shipment_id); } catch (e) {}
      try { await assignPickupManifest(currentOrder); } catch (e) {}
    });

    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: walletId },
      {
        $inc: { balance: -charges },
      },
      { new: true }
    );

    // 🔁 Dual-write: mirror to WalletTransaction for future migration
    if (updatedWallet) {
      await WalletTransaction.create({
        walletId: updatedWallet._id,
        channelOrderId: currentOrder.orderId,
        category: "debit",
        amount: charges,
        balanceAfterTransaction: updatedWallet.balance,
        date: new Date(),
        awb_number,
        description: "Freight Charges Applied",
        priceBreakup,
      });
    }

    return { status: 201, message: "Shipment Created Successfully", waybill: awb_number, orderId: currentOrder.orderId };
  } catch (error) {
    console.error("ShipRocket Bulk Shipment Error:", error.response?.data || error.message);
    return { status: 500, error: "Internal Server Error", message: error.response?.data?.message || error.message };
  }
};

module.exports = { createShipmentFunctionShipRocket };
