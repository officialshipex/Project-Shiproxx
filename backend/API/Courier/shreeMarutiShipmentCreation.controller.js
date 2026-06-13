const BASE_URL = process.env.SHREEMA_PRODUCTION_URL;
const {
  getToken,
} = require("../../AllCouriers/ShreeMaruti/Authorize/shreeMaruti.controller");
const mongoose = require("mongoose");
const axios = require("axios");
const Services = require("../../models/CourierService.Schema");
const Order = require("../../models/newOrder.model");
const user = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

function sanitizeAddress(str) {
  if (!str) return "";
  return str
    .replace(/[^a-zA-Z0-9\s,\/.\-#&]/g, " ")
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

const createShreeMarutiShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  priceBreakup,
  userId,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  const OID = id.toString().slice(-6);
  const t = (label) => `⏱ [SM-${OID}] ${label}`;
  console.time(t("total"));

  const API_URL = `${BASE_URL}/fulfillment/public/seller/order/ecomm/push-order`;
  const MANIFEST_API = `${BASE_URL}/fulfillment/public/seller/order/create-manifest`;

  console.time(t("getToken"));
  const token = await getToken();
  console.timeEnd(t("getToken"));

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    console.time(t("startSession"));
    const session = await mongoose.startSession();
    console.timeEnd(t("startSession"));

    try {
      session.startTransaction();

      console.time(t("findService"));
      const services = await Services.findOne({
        name: courierServiceName,
      }).session(session);
      console.timeEnd(t("findService"));

      // Atomically lock the order
      console.time(t("lockOrder"));
      let currentOrder = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true, session }
      );
      console.timeEnd(t("lockOrder"));

      if (!currentOrder) {
        await session.abortTransaction();
        session.endSession();
        console.timeEnd(t("total"));
        return {
          success: false,
          message: "Order is already being processed or not in 'new' status.",
        };
      }

      console.time(t("getZone"));
      const zone = await getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      );
      console.timeEnd(t("getZone"));

      // Step 5️⃣ Fetch estimated delivery date from DB
      console.time(t("findEDD"));
      const eddData = await estimatedDeliveryDate.findOne({
        courier: "Shree Maruti",
        serviceName: courierServiceName.trim(),
      });
      console.timeEnd(t("findEDD"));

      let estimateDate = null;
      if (eddData) {
        let deliveryDays = null;
        if (
          eddData.zoneRates &&
          typeof eddData.zoneRates[zone.zone] === "number"
        ) {
          deliveryDays = eddData.zoneRates[zone.zone];
        } else if (typeof eddData[zone.zone] === "number") {
          deliveryDays = eddData[zone.zone];
        }
        if (deliveryDays) {
          estimateDate = new Date();
          estimateDate.setDate(estimateDate.getDate() + deliveryDays);
        }
      }

      // Wallet balance check
      const effectiveBalance = walletBalance - walletHoldAmount;
      const balance = effectiveBalance + walletCreditLimit;
      if (balance < finalCharges) {
        await session.abortTransaction();
        session.endSession();
        console.timeEnd(t("total"));
        return { success: false, message: "Insufficient Wallet Balance" };
      }

      // Construct line items
      const lineItems = currentOrder.productDetails.map((item) => ({
        name: item.name,
        quantity: Number(item.quantity) || 0,
        price: Number(item.unitPrice) * Number(item.quantity) || 0,
        unitPrice: Number(item.unitPrice) || 0,
        weight: currentOrder.packageDetails?.applicableWeight
          ? Math.max(
            Number(currentOrder.packageDetails.applicableWeight) * 1000,
            1
          )
          : 1,
        sku: item.sku || null,
      }));

      const payment_type =
        currentOrder.paymentDetails.method === "COD" ? "COD" : "ONLINE";
      const payment_status =
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
          name: sanitizeAddress(currentOrder.pickupAddress.contactName),
          phone: currentOrder.pickupAddress.phoneNumber.toString(),
          address1: sanitizeAddress(currentOrder.pickupAddress.address),
          city: sanitizeAddress(currentOrder.pickupAddress.city),
          state: normalizeState(currentOrder.pickupAddress.state),
          country: "India",
          zip: currentOrder.pickupAddress.pinCode,
        },
        shippingAddress: {
          name: sanitizeAddress(currentOrder.receiverAddress.contactName),
          phone: currentOrder.receiverAddress.phoneNumber.toString(),
          address1: sanitizeAddress(currentOrder.receiverAddress.address),
          city: sanitizeAddress(currentOrder.receiverAddress.city),
          state: normalizeState(currentOrder.receiverAddress.state),
          country: "India",
          zip: currentOrder.receiverAddress.pinCode,
        },
        pickupAddress: {
          name: sanitizeAddress(currentOrder.pickupAddress.contactName),
          phone: currentOrder.pickupAddress.phoneNumber.toString(),
          address1: sanitizeAddress(currentOrder.pickupAddress.address),
          city: sanitizeAddress(currentOrder.pickupAddress.city),
          state: normalizeState(currentOrder.pickupAddress.state),
          country: "India",
          zip: currentOrder.pickupAddress.pinCode,
        },
        returnAddress: {
          name: sanitizeAddress(currentOrder.pickupAddress.contactName),
          phone: currentOrder.pickupAddress.phoneNumber.toString(),
          address1: sanitizeAddress(currentOrder.pickupAddress.address),
          city: sanitizeAddress(currentOrder.pickupAddress.city),
          state: normalizeState(currentOrder.pickupAddress.state),
          country: "India",
          zip: currentOrder.pickupAddress.pinCode,
        },
        selectedCarriers: [{ shortName: "SMILE" }],
        deliveryPromise:
          services.courierType === "Domestic (Surface)" ? "SURFACE" : "AIR",
      };

      // --- Call Shipment API ---
      let response;
      try {
        console.time(t("shreemarutiAPI"));
        response = await axios.post(API_URL, payload, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          timeout: 30000,
        });
        console.timeEnd(t("shreemarutiAPI"));
      } catch (shipmentErr) {
        console.timeEnd(t("shreemarutiAPI"));
        await session.abortTransaction();
        session.endSession();
        const errMsg =
          shipmentErr.response?.data?.message ||
          shipmentErr.response?.data ||
          shipmentErr.message;
        console.error("Shipment API failed:", errMsg);
        console.timeEnd(t("total"));
        return {
          success: false,
          message: shipmentErr.response?.data?.message || "Shipment creation failed",
          details: typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg),
        };
      }

      if (response.status === 200) {
        const result = response.data.data;

        const balanceToBeDeducted = parseFloat(finalCharges);

        currentOrder.status = "Booked";
        currentOrder.cancelledAtStage = null;
        currentOrder.awb_number = result.awbNumber;
        currentOrder.shipment_id = result.shipperOrderId;
        currentOrder.provider = provider;
        currentOrder.totalFreightCharges = finalCharges;
        currentOrder.shipmentCreatedAt = new Date();
        currentOrder.courierServiceName = courierServiceName;
        currentOrder.estimatedDeliveryDate = estimateDate;
        currentOrder.zone = zone.zone;
        currentOrder.priceBreakup = priceBreakup;
        currentOrder.tracking.push({
          status: "Booked",
          StatusLocation: currentOrder.pickupAddress?.city || "N/A",
          StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          Instructions: "Order booked successfully",
        });

        await currentOrder.save({ session });

        await Promise.all([
          Wallet.updateOne(
            { _id: walletId },
            {
              $inc: { balance: -balanceToBeDeducted },
            },
            { session }
          ),
          WalletTransaction.create(
            [
              {
                walletId: walletId,
                channelOrderId: currentOrder.orderId || null,
                category: "debit",
                amount: balanceToBeDeducted,
                balanceAfterTransaction: walletBalance - balanceToBeDeducted,
                date: new Date(),
                awb_number: result.awbNumber || "",
                description: `Freight Charges Applied`,
                priceBreakup
              }
            ],
            { session }
          )
        ]);

        await session.commitTransaction();
        session.endSession();

        // ── Auto-assign pickup manifest (groups by date + address + courier) (non-blocking) ──
        Order.findById(currentOrder._id)
          .then((freshOrder) => {
            if (freshOrder) assignPickupManifest(freshOrder);
          })
          .catch((pErr) => {
            console.error("[Pickup] assignPickupManifest failed (non-blocking):", pErr.message);
          });

        // --- Call Manifest API (outside transaction) ---
        try {
          console.time(t("manifestAPI"));
          const manifestResponse = await axios.post(
            MANIFEST_API,
            { awbNumber: [result.awbNumber] },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              timeout: 15000,
            }
          );
          console.timeEnd(t("manifestAPI"));
          console.log("Manifest Created:", manifestResponse.data);
        } catch (manifestErr) {
          console.timeEnd(t("manifestAPI"));
          console.error(
            "Error creating manifest:",
            manifestErr.response?.data || manifestErr.message
          );
        }

        console.timeEnd(t("total"));
        return {
          success: true,
          message: "Shipment & Manifest Created Successfully",
          awb_number: result.awbNumber,
        };
      } else {
        await session.abortTransaction();
        session.endSession();
        console.timeEnd(t("total"));
        return {
          success: false,
          message: response.data?.message || "Error creating shipment",
          details: response.data,
        };
      }
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();
      console.timeEnd(t("total"));

      const isTransient =
        error.errorLabels?.includes("TransientTransactionError") ||
        error.code === 112 ||
        error.message?.includes("WriteConflict");

      if (isTransient && attempt < maxRetries) {
        console.warn(`[API Shree Maruti createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }

      console.error("Error:", error.response?.data || error.message);
      return {
        success: false,
        message: error.response?.data?.message || error.message || "Internal Server Error",
        error: error.message,
      };
    }
  }
};
module.exports = createShreeMarutiShipment;
