if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const User = require("../../../models/User.model");
const { getShadowfaxToken } = require("../Authorize/saveCourierController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const SHADOWFAX_BASE_URL =
  process.env.SHADOWFAX_URL || "https://dale.shadowfax.in/api";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const getAuthHeaders = async (courierName) => {
  const token = await getShadowfaxToken(courierName);
  return {
    Authorization: `Token ${token}`,
    "Content-Type": "application/json",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// CHECK PINCODE SERVICEABILITY
// GET /v1/clients/serviceability/?service=customer_delivery&pincodes=<pin>
// ─────────────────────────────────────────────────────────────────────────────
const checkPincodeServiceability = async (pincode, courierName) => {
  try {
    const headers = await getAuthHeaders(courierName);
    const response = await axios.get(
      `${SHADOWFAX_BASE_URL}/v1/clients/serviceability/`,
      {
        headers,
        params: {
          service: "customer_delivery",
          page: 1,
          count: 1,
          pincodes: pincode,
        },
        timeout: 10000,
      }
    );
    const data = response.data;
    // console.log("response data",response.data)
    if (Array.isArray(data) && data.length > 0) {
      return { success: true, serviceable: true, data };
    }
    return { success: true, serviceable: false, data: [] };
  } catch (error) {
    console.error("Shadowfax serviceability error:", error.message);
    return { success: false, serviceable: false, error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER (Warehouse model – most common for B2C sellers)
// POST /v3/clients/orders/
// ─────────────────────────────────────────────────────────────────────────────
const createOrder = async (req, res) => {
  const MAX_RETRIES = 1;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      attempt++;
      const {
        id,
        provider,
        courierName,
        finalCharges,
        courierServiceName,
        estimatedDeliveryDate,
        priceBreakup
      } = req.body;

      // ── Fetch order & Lock ────────────────────────────────────────────────
      const currentOrder = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true, session }
      );

      if (!currentOrder) {
        await session.abortTransaction();
        session.endSession();
        return res
          .status(404)
          .json({
            success: false,
            message: "Shipment cannot be created because order is already processed or not in 'new' status."
          });
      }

      // ── Wallet check ──────────────────────────────────────────────────────
      const userDoc = await User.findById(currentOrder.userId).session(session);
      if (!userDoc) throw new Error("User linked with order not found.");

      const currentWallet = await Wallet.findById(userDoc.Wallet).select("balance holdAmount creditLimit").session(session);
      if (!currentWallet) throw new Error("Wallet linked with user not found.");

      const balanceToBeDeducted = finalCharges === "N/A" ? 0 : parseFloat(finalCharges);

      const totalBalance = (currentWallet.balance || 0) + (currentWallet.creditLimit || 0);
      const effectiveBalance = totalBalance - (currentWallet.holdAmount || 0);

      if (effectiveBalance < balanceToBeDeducted) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance (including credit limit).",
        });
      }

      // ── Build Shadowfax payload ───────────────────────────────────────────
      const sender = currentOrder.pickupAddress || {};
      const receiver = currentOrder.receiverAddress || {};
      const product = currentOrder.productDetails?.[0] || {};

      // Determine payment mode
      const paymentMode = currentOrder.paymentDetails.method === "COD" ? "COD" : "Prepaid";
      const codAmount = paymentMode === "COD" ? parseFloat(currentOrder.paymentDetails.amount || 0) : 0;

      // Weight in grams (Shadowfax expects grams)
      const weightGrams = Math.round(
        parseFloat(currentOrder.packageDetails.applicableWeight || product.weight || 0.5) * 1000
      );

      const sfxPayload = {
        order_type: "warehouse",
        order_details: {
          client_order_id: currentOrder.orderId,
          actual_weight: weightGrams,
          volumetric_weight: weightGrams,
          product_value: parseFloat(currentOrder.paymentDetails.amount || 0),
          payment_mode: paymentMode,
          cod_amount: codAmount,
          order_service: "regular",
          total_amount: parseFloat(currentOrder.paymentDetails.amount || 0),
        },
        customer_details: {
          name: receiver.contactName || receiver.name || "Customer",
          contact: String(receiver.phoneNumber || "").replace(/\D/g, "").slice(-10),
          address_line_1: receiver.address || "",
          city: receiver.city || "",
          state: receiver.state || "",
          pincode: parseInt(receiver.pinCode || 0),
        },
        pickup_details: {
          name: sender.contactName || sender.name || "Seller",
          contact: String(sender.phoneNumber || "").replace(/\D/g, "").slice(-10),
          address_line_1: sender.address || "",
          city: sender.city || "",
          state: sender.state || "",
          pincode: parseInt(sender.pinCode || 0),
        },
        rto_details: {
          name: sender.contactName || sender.name || "Seller",
          contact: String(sender.phoneNumber || "").replace(/\D/g, "").slice(-10),
          address_line_1: sender.address || "",
          city: sender.city || "",
          state: sender.state || "",
          pincode: parseInt(sender.pinCode || 0),
        },
        product_details: [
          {
            sku_name: product.name || "Product",
            price: parseFloat(product.price || 0),
            category: "General",
            invoice_no: currentOrder.orderId,
            additional_details: {
              quantity: parseInt(product.quantity || 1),
            },
          },
        ],
      };

      // ── Call Shadowfax API ────────────────────────────────────────────────
      const headers = await getAuthHeaders(courierName || provider || currentOrder.courierServiceName);
      const sfxResponse = await axios.post(
        `${SHADOWFAX_BASE_URL}/v3/clients/orders/`,
        sfxPayload,
        { headers, timeout: 30000 }
      );

      const sfxData = sfxResponse.data;

      if (sfxData.message !== "Success" || !sfxData.data?.awb_number) {
        const errorMsg =
          typeof sfxData.errors === "string"
            ? sfxData.errors
            : JSON.stringify(sfxData.errors || sfxData.message || "Failed to create Shadowfax order");
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: errorMsg });
      }

      // ── Deduct wallet ─────────────────────────────────────────────────────
      if (balanceToBeDeducted > 0) {
        const newBalance = currentWallet.balance - balanceToBeDeducted;
        await Wallet.findOneAndUpdate(
          { _id: currentWallet._id },
          {
            $inc: { balance: -balanceToBeDeducted },
          },
          { session }
        );

        // 🔁 Dual-write: mirror to WalletTransaction for future migration
        await WalletTransaction.create([{
          walletId: currentWallet._id,
          channelOrderId: currentOrder.orderId || null,
          category: "debit",
          amount: balanceToBeDeducted,
          balanceAfterTransaction: newBalance,
          date: new Date(),
          awb_number: sfxData.data.awb_number,
          description: "Freight Charges Applied",
          priceBreakup
        }], { session });
      }

      // ── Update order document ─────────────────────────────────────────────
      currentOrder.awb_number = sfxData.data.awb_number;
      currentOrder.status = "Booked";
      currentOrder.provider = "Shadowfax";
      currentOrder.courierName = courierName || provider || "Shadowfax";
      currentOrder.totalFreightCharges = balanceToBeDeducted;
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.estimatedDeliveryDate = estimatedDeliveryDate;
      currentOrder.priceBreakup = priceBreakup;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: sender.city || "",
        Instructions: "Order booked successfully",
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      });
      await currentOrder.save({ session });

      await session.commitTransaction();
      session.endSession();

      // Auto-assign pickup manifest
      try {
        const freshOrder = await Order.findById(currentOrder._id);
        if (freshOrder) await assignPickupManifest(freshOrder);
      } catch (pErr) {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      }

      return res.status(200).json({
        success: true,
        message: "Order created successfully",
        awb_number: sfxData.data.awb_number,
        order: sfxData.data,
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();

      if (
        error.errorLabels?.includes("TransientTransactionError") &&
        attempt < MAX_RETRIES
      ) {
        console.warn(`Shadowfax transient error on attempt ${attempt}, retrying…`);
        continue;
      }

      console.error("Shadowfax createOrder error:", error.message);
      return res.status(500).json({
        success: false,
        message: error.message || "Internal server error",
      });
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TRACK SHIPMENT
// GET /v4/clients/orders/{awb_number}/track/
// ─────────────────────────────────────────────────────────────────────────────
const trackShadowfaxOrder = async (awb_number, courierName) => {
  try {
    const headers = await getAuthHeaders(courierName);
    const response = await axios.get(
      `${SHADOWFAX_BASE_URL}/v4/clients/orders/${awb_number}/track/`,
      { headers, timeout: 15000 }
    );

    const sfxData = response.data;
    if (sfxData.message !== "Success" || !sfxData.tracking_details) {
      return { success: false, data: null };
    }

    // Shadowfax returns tracking_details as an array (oldest → newest)
    const trackingDetails = sfxData.tracking_details;
    if (!Array.isArray(trackingDetails) || trackingDetails.length === 0) {
      return { success: false, data: null };
    }

    return { success: true, data: trackingDetails };
  } catch (error) {
    console.error(
      `Shadowfax tracking error for AWB ${awb_number}:`,
      error.message
    );
    return { success: false, error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL ORDER
// Shadowfax doesn't have a dedicated cancel endpoint in the public API;
// cancellation is done by setting status to "cancelled_by_seller".
// We call POST /v3/clients/orders/ with the same order_id to trigger it,
// or we mark it internally and rely on the Shadowfax portal/account manager.
// Best approach: return success so UI can mark order cancelled, 
// and the webhook will reflect the true state.
// ─────────────────────────────────────────────────────────────────────────────
const cancelShadowfaxOrder = async (awb_number, courierName) => {
  try {
    const headers = await getAuthHeaders(courierName);
    // console.log("awb", awb_number)
    const response = await axios.post(
      `${SHADOWFAX_BASE_URL}/v3/clients/orders/cancel/`,
      {
        request_id: awb_number,
        cancel_remarks: "Cancelled by user"
      },
      { headers, timeout: 15000 }
    );
    // console.log("awb res", response.data)
    if (response.data.responseCode === 200 || response.data.message === "Success") {
      return { success: true, message: response.data.responseMsg || "Order cancelled successfully." };
    } else {
      return {
        success: false,
        message: response.data.errors ? JSON.stringify(response.data.errors) : (response.data.responseMsg || response.data.message || "Failed to cancel")
      };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
};

module.exports = {
  createOrder,
  trackShadowfaxOrder,
  cancelShadowfaxOrder,
  checkPincodeServiceability,
};
