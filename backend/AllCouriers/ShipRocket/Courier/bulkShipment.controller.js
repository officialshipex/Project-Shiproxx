if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const { getAuthToken } = require("../Authorize/shiprocket.controller");
const { addPickupLocation, requestShipmentPickup, generateLabel } = require("./couriers.controller");
const { findShiprocketService } = require("../../../utils/shiprocketServiceLookup");
const { fitShiprocketAddress } = require("../../../utils/shiprocketAddress");
const { ensurePickupLocation, invalidatePickupLocations, isPickupLocationError } = require("../../../utils/shiprocketPickupCache");
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
// Resolves to { data } on success or { error } with Shiprocket's own reason
// (e.g. the courier does not serve that pincode pair) — a bare "Failed to
// assign AWB" leaves the seller and support with nothing to act on.
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
    const data = response.data?.response?.data || null;
    if (data?.awb_code) return { data };

    console.error("ShipRocket assignAWB (bulk) returned no AWB:", response.data);
    return { error: describeAwbFailure(response.data) };
  } catch (error) {
    console.error("ShipRocket assignAWB (bulk) Error:", error.response?.data || error.message);
    return { error: error.response?.data ? describeAwbFailure(error.response.data) : error.message };
  }
};

// Shiprocket reports an assignment refusal as HTTP 200 with the reason in
// response.data.awb_assign_error, or as an error body with a top-level
// message. Fall back to the raw body so the reason is never lost.
const describeAwbFailure = (body) => {
  if (!body) return "no response from Shiprocket";
  const reason =
    body.response?.data?.awb_assign_error ||
    body.message ||
    body.response?.data?.message ||
    JSON.stringify(body);
  return String(reason).slice(0, 300);
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

    // Resolve the Shiprocket courier_id for the service being booked from
    // CourierService. The bulk callers only pass {provider, name} — this
    // function used to read a `provider_courier_id` off serviceDetails that
    // nothing ever supplies for Shiprocket, so assignAWB always went out with
    // courier_id undefined (dropped from the JSON body entirely) and
    // Shiprocket auto-assigned whichever courier it liked per the account's
    // own priority — e.g. a "DELSRF 500" (Delhivery) booking coming back with
    // a Xpressbees or Shadowfax AWB, while we still recorded "Delhivery" and
    // billed the Delhivery rate. Match the name ignoring case/extra spaces
    // (rate-card names drift from CourierService.name) and refuse to book at
    // all if no courier_id is configured, rather than silently letting
    // Shiprocket pick a different courier than the one being charged for.
    const bookedServiceName = serviceDetails.name || serviceDetails.courierProviderServiceName;
    const serviceDoc = await findShiprocketService(bookedServiceName);
    // Sent as the stored string, exactly like the single-order path — that
    // form is the one proven to be honored by Shiprocket.
    const courier_id = serviceDoc?.courier_id ? String(serviceDoc.courier_id).trim() : null;
    if (!courier_id) {
      return {
        status: 400,
        error: `No Shiprocket courier ID is configured for service "${bookedServiceName}" — not booking, because Shiprocket would auto-assign an arbitrary courier instead of the one being charged for.`,
      };
    }

    const pickupLocationName = wh?.warehouseName || currentOrder.pickupAddress.contactName;
    // Used to re-register this same pickup address for every order in the job
    // (Shiprocket answers "already exists" each time). Only register it when
    // Shiprocket does not already have a location by this name.
    await ensurePickupLocation(token, pickupLocationName, () =>
      addPickupLocation({
        warehouseName: pickupLocationName,
        contactName: currentOrder.pickupAddress.contactName,
        email: currentOrder.pickupAddress.email || SHIPROCKET_EMAIL,
        phoneNumber: currentOrder.pickupAddress.phoneNumber,
        address: currentOrder.pickupAddress.address,
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
        pinCode: currentOrder.pickupAddress.pinCode,
      })
    );

    const senderName = splitName(currentOrder.pickupAddress.contactName);
    const receiverName = splitName(currentOrder.receiverAddress.contactName);
    const isCOD = currentOrder.paymentDetails.method === "COD";

    const order_items = currentOrder.productDetails.map((p) => ({
      name: p.name || "Product",
      sku: p.sku || generateSKU(p.name),
      units: Number(p.quantity) || 1,
      selling_price: parseFloat(p.unitPrice) || 0,
    }));

    // Shiprocket rejects the order if address_1 + address_2 exceed 190 chars.
    const billingAddress = fitShiprocketAddress(currentOrder.pickupAddress.address, currentOrder.pickupAddress);
    const shippingAddress = fitShiprocketAddress(currentOrder.receiverAddress.address, currentOrder.receiverAddress);

    const shipmentPayload = {
      order_id: String(currentOrder.orderId),
      order_date: getCurrentDateTime(),
      pickup_location: pickupLocationName,
      billing_customer_name: senderName.first,
      billing_last_name: senderName.last,
      billing_address: billingAddress,
      billing_city: currentOrder.pickupAddress.city,
      billing_pincode: String(currentOrder.pickupAddress.pinCode),
      billing_state: currentOrder.pickupAddress.state,
      billing_country: "India",
      billing_email: currentOrder.pickupAddress.email || SHIPROCKET_EMAIL,
      billing_phone: cleanPhone(currentOrder.pickupAddress.phoneNumber),
      shipping_is_billing: false,
      shipping_customer_name: receiverName.first,
      shipping_last_name: receiverName.last,
      shipping_address: shippingAddress,
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
    const awbResult = await assignAWB(token, shipment_id, courier_id);
    if (!awbResult.data?.awb_code) return { status: 400, error: `Failed to assign AWB — ${awbResult.error}` };

    const awb_number = awbResult.data.awb_code;
    const courier_name = awbResult.data.courier_name || null;

    // Prefer our own curated courier name over Shiprocket's AWB response —
    // Shiprocket's own `courier_name` is its internal display label
    // bundling courier + service tier + weight slab (e.g. "Delhivery DS
    // 500gm"), not a clean courier name. Storing that raw string as
    // `provider` fragments dashboards/reports that group by provider into
    // dozens of "couriers" that are really just Shiprocket's own rate-plan
    // labels for the same handful of real couriers.
    const curatedCourier = serviceDoc?.courier || null;

    // Amazon-fulfilled services booked through Shiprocket are named with
    // "ATS" (Amazon's own carrier code) by convention — fetch Shiprocket's
    // real label for those so the seller downloads Amazon's original label
    // instead of Shiproxx's generated one. Every other Shiprocket courier is
    // unaffected.
    let atsLabelUrl = null;
    if (/ats/i.test(bookedServiceName || "")) {
      atsLabelUrl = await generateLabel(shipment_id);
    }

    currentOrder.status = "Booked";
    currentOrder.awb_number = awb_number;
    currentOrder.shipment_id = String(shipment_id);
    currentOrder.provider = curatedCourier || courier_name || "Shiprocket";
    currentOrder.partner = "Shiprocket";
    currentOrder.totalFreightCharges = charges;
    currentOrder.courierServiceName = serviceDoc.name;
    if (atsLabelUrl) currentOrder.label = atsLabelUrl;
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
    const errData = error.response?.data;
    console.error("ShipRocket Bulk Shipment Error:", errData || error.message);
    // If Shiprocket rejected the order over its pickup location, our remembered
    // location list is out of date — forget it so the next order re-checks.
    if (isPickupLocationError(errData, error.message)) invalidatePickupLocations();

    // Shiprocket's top-level `message` (e.g. "Oops! Invalid Data.") is too
    // generic for a seller to act on — the actually useful detail is in
    // `errors`, a { field: [reasons] } map. Fold it into the message so the
    // UI shows e.g. "Oops! Invalid Data. — billing_email: The billing email
    // must be a valid email address." instead of just "Invalid Data".
    let message = errData?.message || error.message;
    if (errData?.errors && typeof errData.errors === "object") {
      const fieldMessages = Object.entries(errData.errors)
        .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : msgs}`)
        .join("; ");
      if (fieldMessages) message = `${message} — ${fieldMessages}`;
    }

    return { status: 500, error: "Internal Server Error", message };
  }
};

module.exports = { createShipmentFunctionShipRocket };
