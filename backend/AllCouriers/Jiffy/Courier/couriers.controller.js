const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const { getJiffyToken, JIFFY_BASE_URL } = require("../Authorize/jiffy.controller");

// Jiffy error responses use { error: { message, details? } } — pull that out
// rather than the generic axios/error.message fallback.
const extractJiffyErrorMessage = (err, fallback) =>
  err.response?.data?.error?.message || err.message || fallback;

const splitName = (fullName) => {
  const parts = (fullName || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "." };
};

// ─── Serviceability ──────────────────────────────────────────────────────────
const checkServiceabilityJiffy = async ({
  pickupPincode,
  deliveryPincode,
  rtoPincode,
  weight,
  length,
  breadth,
  height,
  paymentMode,
  collectableAmount,
}) => {
  try {
    if (!pickupPincode || !weight) {
      return { success: false, message: "Required parameters are missing" };
    }

    const token = await getJiffyToken();
    if (!token) return { success: false, message: "Jiffy authentication failed" };

    const response = await axios.post(
      `${JIFFY_BASE_URL}/couriers/serviceability/`,
      {
        source: parseInt(pickupPincode),
        destination: deliveryPincode ? parseInt(deliveryPincode) : undefined,
        rto: rtoPincode ? parseInt(rtoPincode) : parseInt(pickupPincode),
        weight: Number(weight),
        length: Math.round(length || 10),
        width: Math.round(breadth || 10),
        height: Math.round(height || 10),
        payment_method: paymentMode === "cod" ? "cod" : "prepaid",
        collectable_amount: collectableAmount || 0,
      },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 8000,
      }
    );
// console.log("jiffy", response.data)
    if (response.data && response.data.success) {
      return { success: true, data: response.data.data || [] };
    }
    return { success: false, message: response.data?.error?.message || "Not serviceable", data: [] };
  } catch (error) {
    console.error("Jiffy Serviceability Error:", error.response?.data || error.message);
    return { success: false, error: extractJiffyErrorMessage(error, "Serviceability check failed"), data: [] };
  }
};

// ─── Helper: build the /shipments payload from a Shiproxx order ────────────
const buildJiffyShipmentPayload = (currentOrder, courierCode) => {
  const isCOD = currentOrder.paymentDetails?.method === "COD";
  const shipping = splitName(currentOrder.receiverAddress.contactName);
  const warehouse = splitName(currentOrder.pickupAddress.contactName);

  const shippingAddress = {
    first_name: shipping.first,
    last_name: shipping.last,
    company_name: "",
    address: currentOrder.receiverAddress.address,
    address_2: "",
    phone_no: String(currentOrder.receiverAddress.phoneNumber),
    city: currentOrder.receiverAddress.city,
    state: currentOrder.receiverAddress.state,
    country: "India",
    pincode: String(currentOrder.receiverAddress.pinCode),
  };

  const products = currentOrder.productDetails.map((p) => ({
    title: p.name || "Product",
    qty: p.quantity || 1,
    price: Number(p.unitPrice) || 0,
    sku: p.sku && p.sku.length > 0 ? p.sku : `SKU${currentOrder.orderId}`,
  }));

  const payload = {
    order_number: String(currentOrder.orderId),
    api_order_id: String(currentOrder._id),
    order_date: currentOrder.createdAt
      ? new Date(currentOrder.createdAt).toISOString()
      : new Date().toISOString(),
    auto_assign_courier: true,
    weight: Math.round((currentOrder.packageDetails?.applicableWeight || 0.5) * 1000),
    payment_method: isCOD ? "cod" : "prepaid",
    shipping_address: shippingAddress,
    // Shiproxx doesn't track a separate customer billing address — reuse the
    // shipping address, same as every other order placed through this platform.
    billing_address: shippingAddress,
    warehouse: {
      first_name: warehouse.first,
      last_name: warehouse.last,
      company_name: "",
      address: currentOrder.pickupAddress.address,
      address_2: "",
      phone_no: String(currentOrder.pickupAddress.phoneNumber),
      city: currentOrder.pickupAddress.city,
      state: currentOrder.pickupAddress.state,
      country: "India",
      pincode: String(currentOrder.pickupAddress.pinCode),
    },
    package_length: currentOrder.packageDetails?.volumetricWeight?.length || 10,
    package_breadth: currentOrder.packageDetails?.volumetricWeight?.width || 10,
    package_height: currentOrder.packageDetails?.volumetricWeight?.height || 10,
    total_amount: currentOrder.paymentDetails?.amount || 0,
    collectable_amount: isCOD ? currentOrder.paymentDetails?.amount || 0 : 0,
    products,
  };

  if (courierCode) {
    payload.courier_code = courierCode;
  }

  return payload;
};

// ─── Helper: POST /shipments (create + book in one call) ───────────────────
const bookJiffyShipment = async (currentOrder, courierCode) => {
  const token = await getJiffyToken();
  if (!token) throw new Error("Jiffy authentication failed");

  const payload = buildJiffyShipmentPayload(currentOrder, courierCode);
  const response = await axios.post(`${JIFFY_BASE_URL}/shipments`, payload, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    timeout: 15000,
  });

  if (!response.data || !response.data.success || !response.data.data?.awb_number) {
    throw new Error(response.data?.error?.message || "Jiffy did not return a valid AWB number");
  }

  return response.data.data;
};

// ─── Main: Create Jiffy Shipment (single order via HTTP) ───────────────────
const createJiffyShipment = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      id,
      finalCharges,
      courierServiceName,
      courier, // Jiffy courier_code, manually configured on the CourierService doc
      estimatedDeliveryDate,
      priceBreakup,
    } = req.body;

    session.startTransaction();

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

    const [zone, user] = await Promise.all([
      getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode),
      User.findById(currentOrder.userId).session(session),
    ]);

    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Pincode not serviceable" });
    }

    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const currentWallet = await Wallet.findById(user.Wallet)
      .select("balance holdAmount creditLimit")
      .session(session);
    if (!currentWallet) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + (currentWallet.creditLimit || 0);
    if (balance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Insufficient Wallet Balance" });
    }

    let shipmentData;
    try {
      shipmentData = await bookJiffyShipment(currentOrder, courier);
      console.log("Jiffy create shipment response:", shipmentData);
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      console.error("❌ Jiffy create shipment failed:", err.response?.data || err.message);
      return res.status(500).json({
        success: false,
        message: extractJiffyErrorMessage(err, "Failed to create shipment"),
        error: err.response?.data || err.message,
      });
    }

    const awb = shipmentData.awb_number;
    const balanceToDeduct = parseFloat(finalCharges) || 0;
    const providerWord = (shipmentData.courier_name || courierServiceName).split(" ")[0];

    // Order status, wallet debit, and the ledger entry all commit together —
    // if any one fails the whole transaction aborts and the order reverts to
    // "new", so a booked shipment can never end up unpaid (or a wallet debited
    // without a corresponding booked order).
    try {
      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              cancelledAtStage: null,
              awb_number: awb,
              shipment_id: String(shipmentData.id || ""),
              provider: providerWord,
              partner: "Jiffy",
              totalFreightCharges: balanceToDeduct,
              courierServiceName,
              shipmentCreatedAt: new Date(),
              zone: zone.zone,
              estimatedDeliveryDate: estimatedDeliveryDate || "",
              priceBreakup,
            },
            $push: {
              tracking: {
                status: "Booked",
                StatusLocation: currentOrder.pickupAddress?.city || "N/A",
                StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
                Instructions: "Order booked successfully",
              },
            },
          },
          { session, new: true }
        ),
        Wallet.findOneAndUpdate(
          { _id: user.Wallet },
          { $inc: { balance: -balanceToDeduct } },
          { session }
        ),
        WalletTransaction.create(
          [
            {
              walletId: user.Wallet,
              channelOrderId: currentOrder.orderId || null,
              category: "debit",
              amount: balanceToDeduct,
              balanceAfterTransaction: currentWallet.balance - balanceToDeduct,
              date: new Date(),
              awb_number: awb,
              description: "Freight Charges Applied",
              priceBreakup,
            },
          ],
          { session }
        ),
      ]);

      await session.commitTransaction();
      session.endSession();
    } catch (writeErr) {
      // Jiffy already created a real shipment (we have its AWB) but Shiproxx
      // failed to record it — this can't be a wallet/booking mismatch since
      // nothing here commits, but the AWB now exists at Jiffy with no
      // Shiproxx record of it. Surface it loudly rather than losing it in a
      // generic error log.
      console.error(
        `🚨 JIFFY ORPHANED SHIPMENT — order ${currentOrder.orderId} booked at Jiffy with AWB ${awb} but Shiproxx failed to save it. Manual reconciliation required.`,
        writeErr.message
      );
      throw writeErr;
    }

    try {
      const freshOrder = await Order.findById(id);
      if (freshOrder) await assignPickupManifest(freshOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      awb_number: awb,
      orderId: currentOrder.orderId,
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error("❌ Jiffy shipment error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    });
  }
};

// ─── Cancel ──────────────────────────────────────────────────────────────────
const cancelOrderJiffy = async (awb_number) => {
  try {
    if (!awb_number) return { success: false, message: "AWB number is required" };

    const token = await getJiffyToken();
    if (!token) return { success: false, message: "Jiffy authentication failed" };

    const response = await axios.post(
      `${JIFFY_BASE_URL}/shipments/awb/${encodeURIComponent(awb_number)}/cancel`,
      {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );

    if (response.data && response.data.success) {
      return { success: true, message: "Cancelled successfully via Jiffy", data: response.data.data };
    }
    return { success: false, error: response.data?.error?.message || "Cancellation failed" };
  } catch (error) {
    console.error("Jiffy Cancellation Error:", error.response?.data || error.message);
    return { success: false, error: extractJiffyErrorMessage(error, "Failed to cancel shipment") };
  }
};

// ─── Track ───────────────────────────────────────────────────────────────────
const trackOrderJiffy = async (awb_number) => {
  try {
    const token = await getJiffyToken();
    if (!token) return { success: false, error: "Jiffy authentication failed", status: 500 };

    const response = await axios.get(
      `${JIFFY_BASE_URL}/shipments/awb/${encodeURIComponent(awb_number)}/track`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );

    if (response.data && response.data.success) {
      // Jiffy returns tracking_history newest-first (descending) — reverse it
      // to chronological ascending order, which is what order.tracking is
      // stored as and what every "latest scan = array[length-1]" consumer in
      // this codebase (mapTrackingResponse, tracking.controller.js) expects.
      const history = response.data.data?.tracking_history || [];
      return { success: true, data: [...history].reverse() };
    }
    return { success: false, error: response.data?.error?.message || "Tracking failed" };
  } catch (error) {
    console.error("Jiffy tracking error:", error.response?.data || error.message);
    return { success: false, error: extractJiffyErrorMessage(error, "Failed to fetch tracking"), status: 500 };
  }
};

// ─── NDR List ────────────────────────────────────────────────────────────────
const getJiffyNdrList = async (req, res) => {
  try {
    const token = await getJiffyToken();
    if (!token) return res.status(401).json({ success: false, message: "Jiffy authentication failed" });

    const response = await axios.get(`${JIFFY_BASE_URL}/ndr`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        per_page: req.query.per_page,
        current_page: req.query.current_page,
      },
      timeout: 10000,
    });

    return res.status(200).json(response.data);
  } catch (error) {
    console.error("Jiffy NDR List Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch Jiffy NDR List",
      error: error.response?.data || error.message,
    });
  }
};

module.exports = {
  checkServiceabilityJiffy,
  createJiffyShipment,
  cancelOrderJiffy,
  trackOrderJiffy,
  getJiffyNdrList,
  bookJiffyShipment,
  buildJiffyShipmentPayload,
  extractJiffyErrorMessage,
};
