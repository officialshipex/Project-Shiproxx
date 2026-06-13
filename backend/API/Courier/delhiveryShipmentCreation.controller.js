const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const plan = require("../../models/Plan.model");
const { getZone } = require("../../Rate/zoneManagementController");
const {
  createClientWarehouse,
  getUniqueWarehouseName,
} = require("../../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  fetchBulkWaybills,
  getDelhiveryApiKey,
} = require("../../AllCouriers/Delhivery/Authorize/saveCourierContoller");
const { getWaybill } = require("../../AllCouriers/Delhivery/Authorize/waybillPool");
const url = process.env.DELHIVERY_URL;
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const createDelhiveryShipment = async ({
  id,
  provider,
  courierName,
  finalCharges,
  courierServiceName,
  priceBreakup,
  // ✅ PERF FIX: Pre-fetched from bookOrder controller — avoids redundant User/Wallet/Plan loading
  userId,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  // ── Pre-transaction: read-only EDD lookup (no need to hold a write session) ──
  let estimateDate = null;
  try {
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Delhivery",
      serviceName: courierServiceName.trim(),
    }).lean();
    if (eddData) {
      // zone is not known yet; will be refined after getZone() runs inside the transaction
      // Store raw eddData so we can compute the date after zone is resolved
      createDelhiveryShipment._eddData = eddData;
    }
  } catch (_) { /* non-critical — proceed without EDD */ }

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // Step 1️⃣ Fetch order & mark as processing
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

      // Step 2️⃣ Fetch API key only (User/Wallet/Plan already verified by bookOrder controller)
      const apiKey = await getDelhiveryApiKey(courierName || provider);

      if (!walletId) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Wallet not found" };
      }

      // Step 3️⃣ Get waybills (from pool cache), zone & create warehouse in parallel
      const [waybills, zone, warehouseCreationResult] = await Promise.all([
        getWaybill(apiKey),
        getZone(
          currentOrder.pickupAddress.pinCode,
          currentOrder.receiverAddress.pinCode
        ),
        createClientWarehouse(
          currentOrder.pickupAddress,
          apiKey
        ),
      ]);

      if (!waybills || !waybills.length || !zone) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: (!waybills || !waybills.length)
            ? "No Waybill Available"
            : "Pincode not serviceable",
        };
      }

      if (!warehouseCreationResult || !warehouseCreationResult.success) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: "Failed to create or fetch pickup warehouse",
          details: warehouseCreationResult,
        };
      }

      // Step 5️⃣ Compute EDD using zone resolved above (eddData fetched before transaction)
      const eddData = createDelhiveryShipment._eddData || null;
      if (eddData) {
        let deliveryDays = null;
        if (eddData.zoneRates && typeof eddData.zoneRates[zone.zone] === "number") {
          deliveryDays = eddData.zoneRates[zone.zone];
        } else if (typeof eddData[zone.zone] === "number") {
          deliveryDays = eddData[zone.zone];
        }
        if (deliveryDays) {
          estimateDate = new Date();
          estimateDate.setDate(estimateDate.getDate() + deliveryDays);
        }
      }

      // Step 6️⃣ Prepare payload
      const pickupWarehouseName =
        warehouseCreationResult.name ||
        warehouseCreationResult.data?.name ||
        getUniqueWarehouseName(currentOrder.pickupAddress);
      const payment_type =
        currentOrder.paymentDetails.method === "COD" ? "COD" : "Pre-paid";

      const addressLine =
        currentOrder.receiverAddress.address?.substring(0, 160) ||
        "Default Warehouse";

      const payloadData = {
        pickup_location: {
          name: pickupWarehouseName,
        },
        shipments: [
          {
            Waybill: waybills[0],
            country: "India",
            city: currentOrder.receiverAddress.city,
            pin: currentOrder.receiverAddress.pinCode,
            state: currentOrder.receiverAddress.state,
            order: currentOrder.orderId,
            add: addressLine,
            payment_mode: payment_type,
            shipping_mode: "Surface",
            quantity: currentOrder.productDetails
              .reduce((sum, p) => sum + p.quantity, 0)
              .toString(),
            phone: currentOrder.receiverAddress.phoneNumber,
            products_desc: currentOrder.productDetails
              .map((p) => p.name)
              .join(", "),
            total_amount: currentOrder.paymentDetails.amount,
            name: currentOrder.receiverAddress.contactName || "Default Warehouse",
            weight: currentOrder.packageDetails.applicableWeight * 1000,
            shipment_height: currentOrder.packageDetails.volumetricWeight.height,
            shipment_width: currentOrder.packageDetails.volumetricWeight.width,
            shipment_length: currentOrder.packageDetails.volumetricWeight.length,
            cod_amount:
              payment_type === "COD"
                ? `${currentOrder.paymentDetails.amount}`
                : "0",
          },
        ],
      };

      const payload = `format=json&data=${encodeURIComponent(
        JSON.stringify(payloadData)
      )}`;

      // Step 7️⃣ Wallet check (using pre-fetched balance — no heavy document load)
      const effectiveBalance = walletBalance - walletHoldAmount;
      const balanceToBeDeducted =
        finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
      const balance = effectiveBalance + walletCreditLimit;
      if (balance < balanceToBeDeducted) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Insufficient Wallet Balance" };
      }

      // Step 8️⃣ Create shipment via API
      const response = await axios.post(`${url}/api/cmu/create.json`, payload, {
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 8000,
      });

      const result = response.data?.packages?.[0];
      if (!response.data.success || !result) {
         console.log("Delhivery error", result);
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: response.data?.packages?.[0]?.remarks || "Failed to create shipment",
          details: response.data,
        };
      }

      // Step 9️⃣ Update Order & Wallet atomically (with Dual-Write to WalletTransaction)
      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              cancelledAtStage: null,
              awb_number: result.waybill,
              shipment_id: result.refnum,
              provider: provider,
              courierName: courierName || provider,
              totalFreightCharges: balanceToBeDeducted,
              courierServiceName,
              shipmentCreatedAt: new Date(),
              zone: zone.zone,
              estimatedDeliveryDate: estimateDate,
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
        // ✅ PERF FIX: Atomic wallet update by _id — never loads the full wallet document
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
              awb_number: result.waybill || "",
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

      return {
        success: true,
        message: "Shipment Created Successfully",
        awb_number: result.waybill,
        orderId: currentOrder.orderId,
        estimatedDeliveryDate: estimateDate,
      };
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();

      // Check if transient error (Write Conflict)
      const isTransient =
        error.errorLabels?.includes("TransientTransactionError") ||
        error.code === 112 ||
        error.message?.includes("WriteConflict");

      if (isTransient && attempt < maxRetries) {
        console.warn(`[API Delhivery createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }

      return {
        success: false,
        message: error.message || "Error creating shipment",
        error: error.message,
      };
    }
  }
};

module.exports = createDelhiveryShipment;
