const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const { getZone } = require("../../Rate/zoneManagementController");
const { getProshipAccessToken } = require("../../AllCouriers/Proship/Authorize/proship.controller");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const PROSHIP_BASE_URL = "https://proship.prozo.com/api";

const createProshipShipment = async ({
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

    // Step 2️⃣ Wallet check
    if (!walletId) {
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Wallet not found" };
    }

    // Step 3️⃣ Wallet Balance Check
    const effectiveBalance = walletBalance - (walletHoldAmount || 0);
    const balanceToBeDeducted = finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
    const totalBalance = effectiveBalance + (walletCreditLimit || 0);
    
    if (totalBalance < balanceToBeDeducted) {
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // Step 4️⃣ Get Zone
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
      courier: "Proship",
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

    // Step 6️⃣ Authenticate with Proship
    const token = await getProshipAccessToken();
    // console.log("token",token)
    if (!token) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Proship authentication failed" };
    }

    // Step 7️⃣ Prepare Proship Payload
    const proshipPayload = {
      reverse: false,
      order_type: "Forward Shipment",
      item_list: currentOrder.productDetails.map((item) => ({
        units: Number(item.quantity) || 1,
        tax: parseFloat(item.tax) || 0,
        hsn: (item.hsn && !isNaN(item.hsn)) ? item.hsn : "711719905",
        item_name: item.name,
        sku_id: item.sku || String(item.id),
        item_url: "NA",
        selling_price: parseFloat(item.unitPrice) || 0,
      })),
      pickup_details: {
        from_name: currentOrder.pickupAddress.contactName,
        from_phone_number: currentOrder.pickupAddress.phoneNumber,
        from_address: currentOrder.pickupAddress.address,
        from_country: "IN",
        from_email: currentOrder.pickupAddress.email || "info@shipex.in",
        from_pincode: String(currentOrder.pickupAddress.pinCode),
        from_city: currentOrder.pickupAddress.city,
        from_addressline: currentOrder.pickupAddress.address,
        from_state: currentOrder.pickupAddress.state,
        gstin: currentOrder.otherDetails?.gstin || "",
      },
      delivery_details: {
        to_name: currentOrder.receiverAddress.contactName,
        to_phone_number: currentOrder.receiverAddress.phoneNumber,
        to_address: currentOrder.receiverAddress.address,
        to_country: "IN",
        to_email: currentOrder.receiverAddress.email || "NA",
        to_pincode: String(currentOrder.receiverAddress.pinCode),
        to_city: currentOrder.receiverAddress.city,
        to_addressline: currentOrder.receiverAddress.address,
        to_state: currentOrder.receiverAddress.state,
      },
      customer_detail: {
        to_email: currentOrder.receiverAddress.email || "NA",
        to_address: currentOrder.receiverAddress.address,
        to_city: currentOrder.receiverAddress.city,
        to_country: "IN",
        to_state: currentOrder.receiverAddress.state,
      },
      shipment_detail: [
        {
          item_breadth: currentOrder.packageDetails.volumetricWeight?.width || 1.0,
          item_length: currentOrder.packageDetails.volumetricWeight?.length || 1.0,
          item_height: currentOrder.packageDetails.volumetricWeight?.height || 1.0,
          item_weight: (currentOrder.packageDetails.applicableWeight || 0.5) * 1000,
        },
      ],
      invoice_value: currentOrder.paymentDetails.amount,
      cod_amount: currentOrder.paymentDetails.method === "COD" ? currentOrder.paymentDetails.amount : 0,
      client_order_id: String(currentOrder.orderId),
      is_reverse: false,
      invoice_number: String(currentOrder.orderId),
      transaction_charge: 0.0,
      giftwrap_charge: 0.0,
      payment_mode: currentOrder.paymentDetails.method === "COD" ? "COD" : "PREPAID",
      reference: `ORD-${currentOrder.orderId}`,
      channel_name: courierServiceName?.toLowerCase().includes("dtdc")
        ? "dtdc-surface"
        : courierServiceName?.toLowerCase().includes("shadowfax")
        ? "shadowfax-surface"
        : "WMS",
    };

    // Step 8️⃣ Call Proship API
    const response = await axios.post(`${PROSHIP_BASE_URL}/order/create`, proshipPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    if (
      !response.data ||
      !response.data.meta ||
      response.data.meta.status !== "200 OK" ||
      !response.data.result ||
      !response.data.result.awb_number
    ) {
        await session.abortTransaction();
        session.endSession();
        return {
            success: false,
            message: response.data?.meta?.message || "Proship order creation failed",
            details: response.data
        };
    }

    const { awb_number } = response.data.result;

    // Step 9️⃣ Update Order & Wallet atomically
    await Promise.all([
      Order.findByIdAndUpdate(
        id,
        {
          $set: {
            status: "Booked",
            cancelledAtStage: null,
            awb_number: awb_number,
            shipment_id: response.data.result.id || String(currentOrder.orderId),
            provider: courierServiceName?.toLowerCase().includes("dtdc") ? "Dtdc" : "Shadowfax",
            partner: "Proship",
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
            awb_number: awb_number || "",
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
      awb_number: awb_number,
      orderId: currentOrder.orderId,
      estimatedDeliveryDate: estimateDate,
    };
  } catch (error) {
    if (session.inTransaction()) {
        await session.abortTransaction();
    }
    session.endSession();
    console.error("Proship Creation Error:", error.response?.data || error.message);
    return {
      success: false,
      message: "Error creating shipment",
      error: error.response?.data?.meta?.message || error.message,
    };
  }
};

module.exports = createProshipShipment;
