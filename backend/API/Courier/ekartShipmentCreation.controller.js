const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const mongoose = require("mongoose");
const { getAccessToken } = require("../../AllCouriers/Ekart/Authorize/Ekart.controller")
const pickupAddress = require("../../models/pickupAddress.model");
const { calculateGSTForItems, addEkartAddress } = require("../../AllCouriers/Ekart/Couriers/couriers.controller");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");


const createEkartShipment = async ({
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
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const session = await mongoose.startSession();

    try {
      const accessToken = await getAccessToken(courierServiceName);
      if (!accessToken) {
        session.endSession();
        return {
          success: false,
          message: "Failed to get Ekart access token",
        };
      }

      session.startTransaction();

      // 1️⃣ Lock order
      const currentOrder = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true, session },
      );

      if (!currentOrder) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: "Order not in 'new' status",
        };
      }

      const eddData = await estimatedDeliveryDate.findOne({
        courier: "Ekart",
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

      // 2️⃣ Zone check
      const zone = await getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode,
      );

      if (!zone) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Pincode not serviceable" };
      }

      // 3️⃣ Wallet check
      const holdAmount = walletHoldAmount || 0;
      const effectiveBalance = walletBalance - holdAmount;
      const balance = effectiveBalance + walletCreditLimit;

      if (balance < finalCharges) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Insufficient Wallet Balance" };
      }

      // 4️⃣ Pickup address
      let pickup = await pickupAddress
        .findOne({
          "pickupAddress.contactName": currentOrder.pickupAddress.contactName,
          "pickupAddress.address": currentOrder.pickupAddress.address,
          "pickupAddress.pinCode": currentOrder.pickupAddress.pinCode,
        })
        .session(session);

      if (!pickup) {
        const newAddress = new pickupAddress({
          userId: currentOrder.userId,
          pickupAddress: {
            contactName: currentOrder.pickupAddress.contactName,
            email: currentOrder.pickupAddress.email || "test@test.com",
            phoneNumber: currentOrder.pickupAddress.phoneNumber,
            address: currentOrder.pickupAddress.address,
            pinCode: currentOrder.pickupAddress.pinCode,
            city: currentOrder.pickupAddress.city,
            state: currentOrder.pickupAddress.state,
          },
        });
        pickup = await newAddress.save({ session });
      }

      let ekartAlias = pickup.ekartAlias;

      // 5️⃣ Register pickup if alias missing
      if (!ekartAlias) {
        const addResult = await addEkartAddress(
          {
            alias: `WAREHOUSE_${Date.now()}`,
            phone: pickup.pickupAddress.phoneNumber,
            address_line1: pickup.pickupAddress.address,
            address_line2: "",
            pincode: pickup.pickupAddress.pinCode,
            city: pickup.pickupAddress.city,
            state: pickup.pickupAddress.state,
            country: "IN",
            geo: { lat: 0, lon: 0 },
          },
          accessToken,
        );

        if (!addResult?.success) {
          await session.abortTransaction();
          session.endSession();
          return {
            success: false,
            message: "Failed to register pickup address with Ekart",
            error: addResult?.error,
          };
        }

        ekartAlias = addResult.alias;

        await pickupAddress.updateOne(
          { _id: pickup._id },
          { ekartAlias },
          { session },
        );
      }

      // 6️⃣ GST calculation
      const { updatedItems, totalTaxValue } = calculateGSTForItems(
        currentOrder.productDetails,
        pickup.pickupAddress.state.trim(),
        currentOrder.receiverAddress.state.trim(),
        process.env.SELLER_GST_TIN || "",
      );

      const todayStr = new Date().toISOString().split("T")[0];
      const isCOD = currentOrder.paymentDetails.method === "COD";

      const cleanItems = updatedItems.map((i) => (i.toObject ? i.toObject() : i));

      const totalQuantity = cleanItems.reduce(
        (s, p) => s + (p._doc.quantity || 0),
        0,
      );

      const items = cleanItems.map((p) => ({
        product_name: p._doc.name,
        sku: p._doc.sku,
        taxable_value: p.taxable_value,
        cgst_tax_value: p.cgst_tax_value,
        sgst_tax_value: p.sgst_tax_value,
        igst_tax_value: p.igst_tax_value,
        quantity: p._doc.quantity,
        description: p._doc.name,
        length:
          p.length || currentOrder.packageDetails.volumetricWeight.length || 0,
        height:
          p.height || currentOrder.packageDetails.volumetricWeight.height || 0,
        breadth:
          p.width || currentOrder.packageDetails.volumetricWeight.width || 0,
        weight: p.weight || currentOrder.packageDetails.applicableWeight || 1,
        hsn_code: p._doc?.hsnCode || "",
      }));

      // 7️⃣ Ekart payload
      const payload = {
        seller_name: pickup.pickupAddress.contactName,
        seller_address: pickup.pickupAddress.address,
        seller_gst_tin: process.env.SELLER_GST_TIN || "",

        order_number: String(currentOrder.orderId),
        invoice_number: String(currentOrder.orderId),
        invoice_date: todayStr,

        consignee_gst_amount: totalTaxValue,
        consignee_name: currentOrder.receiverAddress.contactName,
        products_desc: updatedItems.map((p) => p.name).join(", ") || "Goods",

        payment_mode: isCOD ? "COD" : "Prepaid",
        total_amount: currentOrder.paymentDetails.amount,
        taxable_amount: currentOrder.paymentDetails.amount,
        _taxable_amount: currentOrder.paymentDetails.amount,
        tax_value: totalTaxValue,
        commodity_value: String(
          currentOrder.paymentDetails.amount - totalTaxValue,
        ),
        cod_amount: isCOD ? currentOrder.paymentDetails.amount : 0,

        quantity: totalQuantity,

        weight: currentOrder.packageDetails.applicableWeight,
        length: currentOrder.packageDetails.volumetricWeight.length,
        height: currentOrder.packageDetails.volumetricWeight.height,
        width: currentOrder.packageDetails.volumetricWeight.width,

        drop_location: {
          location_type: "Office",
          address: currentOrder.receiverAddress.address,
          city: currentOrder.receiverAddress.city,
          state: currentOrder.receiverAddress.state,
          country: "IN",
          name: currentOrder.receiverAddress.contactName,
          phone: Number(currentOrder.receiverAddress.phoneNumber),
          pin: Number(currentOrder.receiverAddress.pinCode),
        },

        pickup_location: { name: ekartAlias },
        return_location: { name: ekartAlias },

        items,
        what3words_address: "",
      };

      // 8️⃣ Ekart API call
      let response;
      try {
        response = await axios.put(
          "https://app.elite.ekartlogistics.in/api/v1/package/create",
          payload,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000,
          },
        );
      } catch (err) {
        const ekartErr = err.response?.data;
        console.log("[Ekart API] Shipment Error:", ekartErr || err.message);

        // ✅ If address not registered with Ekart → re-create, update DB, retry
        if (
          err.response?.status === 404 &&
          ekartErr?.message === "SWIFT_RESOURCE_NOT_FOUND_EXCEPTION"
        ) {
          console.log(`[Ekart API] Re-registering address for pickup: ${pickup?._id}`);

          const newAddressPayload = {
            alias: `WAREHOUSE_${Date.now()}`,
            phone: pickup.pickupAddress.phoneNumber,
            address_line1: pickup.pickupAddress.address,
            address_line2: "",
            pincode: pickup.pickupAddress.pinCode,
            city: pickup.pickupAddress.city,
            state: pickup.pickupAddress.state,
            country: "IN",
            geo: { lat: 0, lon: 0 },
          };

          const reRegResult = await addEkartAddress(newAddressPayload, accessToken);

          if (!reRegResult.success) {
            await session.abortTransaction();
            session.endSession();
            return {
              success: false,
              message: "Ekart address not registered. Re-registration also failed.",
              error: reRegResult.error,
            };
          }

          const newAlias = reRegResult.alias;
          console.log(`[Ekart API] Re-registered address with alias: ${newAlias}`);

          // Update alias in DB
          await pickupAddress.updateOne(
            { _id: pickup._id },
            { $set: { ekartAlias: newAlias } },
          );

          // Update payload and retry
          payload.pickup_location = { name: newAlias };
          payload.return_location = { name: newAlias };

          try {
            response = await axios.put(
              "https://app.elite.ekartlogistics.in/api/v1/package/create",
              payload,
              {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 15000,
              },
            );
            console.log("[Ekart API] Retry Shipment Response:", response.data);
          } catch (retryErr) {
            await session.abortTransaction();
            session.endSession();
            return {
              success: false,
              message:
                retryErr.response?.data?.description ||
                "Ekart Shipment Failed after address re-registration",
              error: retryErr.response?.data || retryErr.message,
            };
          }
        } else {
          // Other errors → fail immediately
          await session.abortTransaction();
          session.endSession();
          return {
            success: false,
            message:
              err.code === "ECONNABORTED"
                ? "Ekart timeout"
                : ekartErr?.description || "Ekart Shipment Failed",
            error: ekartErr || err.message,
          };
        }
      }

      if (!response?.data?.status) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: response.data?.message || "Ekart error",
        };
      }

      // 9️⃣ Order and Wallet update
      const balanceToBeDeducted = parseFloat(finalCharges);

      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              awb_number: response.data.tracking_id,
              shipment_id: currentOrder.orderId,
              provider,
              courierServiceName,
              totalFreightCharges: balanceToBeDeducted,
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
          { session },
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
              channelOrderId: currentOrder.orderId,
              category: "debit",
              amount: balanceToBeDeducted,
              balanceAfterTransaction: walletBalance - balanceToBeDeducted,
              date: new Date(),
              awb_number: response.data.tracking_id,
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
        awb_number: response.data.tracking_id,
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
        console.warn(`[API Ekart createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }

      return {
        success: false,
        message: "Failed to create shipment",
        error: error.message,
      };
    }
  }
};

module.exports = createEkartShipment;
