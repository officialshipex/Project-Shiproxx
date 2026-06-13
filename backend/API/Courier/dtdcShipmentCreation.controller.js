const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const DTDC_API_URL = process.env.DTDC_API_URL;
const API_KEY = process.env.DTDC_API_KEY;
const X_ACCESS_TOKEN = process.env.DTDC_X_ACCESS_TOKEN;
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const mongoose = require("mongoose");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

/**
 * Create shipment order with given parameters
 * @param {object} params
 * @param {string} params.id - Order ID
 * @param {string} params.provider - Provider name
 * @param {number|string} params.finalCharges - Freight charges
 * @param {string} params.courierServiceName - Courier service name
 * @param {string} params.courier - Service type id (mandatory)
 * @param {string} params.API_KEY - API key for authentication
 * @param {string} params.X_ACCESS_TOKEN - Access token for authentication
 * @param {string} params.DTDC_API_URL - Base URL for DTDC API
 * @returns {Promise<object>} Result object with success status and data or error details
 */
const createDTDCShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  courier,
  priceBreakup,
  userId,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  if (!courier) {
    return {
      success: false,
      message: "service_type_id missing please refresh your page",
    };
  }

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // --- Lock and fetch order atomically ---
      const currentOrder = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true, session }
      );

      if (!currentOrder) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message:
            "Shipment cannot be created because order is already processed or not in 'new' status.",
        };
      }

      // --- Fetch zone ---
      const zone = await getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      );

      if (!zone) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Pincode not serviceable" };
      }

      // Step 5️⃣ Fetch estimated delivery date from DB
      const eddData = await estimatedDeliveryDate.findOne({
        courier: "Dtdc",
        serviceName: courierServiceName.trim(),
      });

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

      // --- Wallet balance check ---
      const effectiveBalance = walletBalance - walletHoldAmount;
      const balance = effectiveBalance + walletCreditLimit;
      if (balance < finalCharges) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Insufficient Wallet Balance" };
      }

      // --- Prepare shipment payload ---
      const productNames = currentOrder.productDetails
        .map((p) => p.name)
        .join(", ");

      const codCollectionMode =
        currentOrder.paymentDetails.method === "COD" ? "cash" : null;
      const codAmount =
        currentOrder.paymentDetails.method === "COD"
          ? currentOrder.paymentDetails.amount
          : 0;

      const shipmentData = {
        consignments: [
          {
            customer_code: "GL9711",
            service_type_id: courier,
            load_type: "NON-DOCUMENT",
            description: productNames,
            dimension_unit: "cm",
            length: currentOrder.packageDetails.volumetricWeight.length,
            width: currentOrder.packageDetails.volumetricWeight.width,
            height: currentOrder.packageDetails.volumetricWeight.height,
            weight_unit: "kg",
            weight: currentOrder.packageDetails.applicableWeight,
            declared_value: currentOrder.paymentDetails.amount,
            num_pieces: currentOrder.productDetails.length,

            origin_details: {
              name: currentOrder.pickupAddress.contactName,
              phone: currentOrder.pickupAddress.phoneNumber,
              address_line_1: currentOrder.pickupAddress.address,
              pincode: currentOrder.pickupAddress.pinCode,
              city: currentOrder.pickupAddress.city,
              state: currentOrder.pickupAddress.state,
            },

            destination_details: {
              name: currentOrder.receiverAddress.contactName,
              phone: currentOrder.receiverAddress.phoneNumber,
              address_line_1: currentOrder.receiverAddress.address,
              pincode: currentOrder.receiverAddress.pinCode,
              city: currentOrder.receiverAddress.city,
              state: currentOrder.receiverAddress.state,
            },

            customer_reference_number: currentOrder.orderId,
            cod_collection_mode: codCollectionMode,
            cod_amount: codAmount,
            ...(courierServiceName === "Dtdc Air" && {
              commodity_id: "Others",
            }),
            reference_number: "",
          },
        ],
      };

      // --- Call DTDC API ---
      let response;
      try {
        response = await axios.post(
          `${DTDC_API_URL}/customer/integration/consignment/softdata`,
          shipmentData,
          {
            headers: {
              "Content-Type": "application/json",
              "api-key": API_KEY,
              Authorization: `Bearer ${X_ACCESS_TOKEN}`,
            },
            timeout: 15000,
          }
        );
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        console.error("❌ DTDC API failed:", err.response?.data || err.message);
        return {
          success: false,
          message: err.response?.data?.message || "Shipment API failed",
          error: err.response?.data || err.message,
        };
      }

      const result = response?.data?.data?.[0];
      if (!result?.success) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: result?.message || "Shipment failed",
        };
      }

      // --- Update order and wallet atomically inside session ---
      const balanceToBeDeducted = parseFloat(finalCharges) || 0;

      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              cancelledAtStage: null,
              awb_number: result.reference_number,
              shipment_id: result.customer_reference_number,
              provider,
              totalFreightCharges: balanceToBeDeducted,
              courierServiceName,
              shipmentCreatedAt: new Date(),
              zone: zone.zone,
              estimatedDeliveryDate: estimateDate || "",
              priceBreakup
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
          { session }
        ),
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
              awb_number: result.reference_number || "",
              description: "Freight Charges Applied",
              priceBreakup
            }
          ],
          { session }
        )
      ]);

      await session.commitTransaction();
      session.endSession();

      // ── Auto-assign pickup manifest (non-blocking) ──
      Order.findById(id)
        .then((freshOrder) => {
          if (freshOrder) assignPickupManifest(freshOrder);
        })
        .catch((pErr) => {
          console.error("[Pickup] assignPickupManifest failed:", pErr.message);
        });

      // --- Return success ---
      return {
        success: true,
        message: "Shipment Created Successfully",
        awb_number: result.reference_number,
      };
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();

      const isTransient =
        error.errorLabels?.includes("TransientTransactionError") ||
        error.code === 112 ||
        error.message?.includes("WriteConflict");

      if (isTransient && attempt < maxRetries) {
        console.warn(`[API DTDC createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }

      console.error("❌ Error creating DTDC shipment:", error.message);
      return {
        success: false,
        message: error.message || "Failed to create shipment",
        error: error.message,
      };
    }
  }
};

module.exports = createDTDCShipment;
