const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const plan = require("../../models/Plan.model");
const { getZone } = require("../../Rate/zoneManagementController");
const { getShadowfaxToken } = require("../../AllCouriers/Shadowfax/Authorize/saveCourierController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const SHADOWFAX_BASE_URL = process.env.SHADOWFAX_URL || "https://dale.shadowfax.in/api";

const createShadowfaxShipment = async ({
  id,
  provider,
  courierName,
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
        message: "Shipment cannot be created because order is already processed or not in 'new' status.",
      };
    }

    // Step 2️⃣ Wallet check
    if (!walletId) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Wallet not found" };
    }

    // Fetch API Key
    const apiKey = await getShadowfaxToken(courierName || provider);
    if (!apiKey) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Shadowfax API Token not found" };
    }

    // Step 3️⃣ Get Zone
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Pincode not serviceable (Zone not found)" };
    }

    // Step 4️⃣ Fetch EDD
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Shadowfax",
      serviceName: courierServiceName.trim(),
    });

    let estimateDate = null;
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

    // Step 5️⃣ Wallet check
    const holdAmount = walletHoldAmount || 0;
    const effectiveBalance = walletBalance - holdAmount;
    const balanceToBeDeducted = finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
    const balance = effectiveBalance + (walletCreditLimit || 0);

    if (balance < balanceToBeDeducted) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // Step 6️⃣ Prepare Shadowfax Payload
    const sender = currentOrder.pickupAddress || {};
    const receiver = currentOrder.receiverAddress || {};
    const product = currentOrder.productDetails?.[0] || {}; // Simplified for unified API

    const paymentMode = currentOrder.paymentDetails.method === "COD" ? "COD" : "Prepaid";
    const weightGrams = Math.round(parseFloat(currentOrder.packageDetails.applicableWeight || 0.5) * 1000);

    const sfxPayload = {
      order_type: "warehouse",
      order_details: {
        client_order_id: currentOrder.orderId,
        actual_weight: weightGrams,
        volumetric_weight: weightGrams,
        product_value: parseFloat(currentOrder.paymentDetails.amount || 0),
        payment_mode: paymentMode,
        cod_amount: paymentMode === "COD" ? parseFloat(currentOrder.paymentDetails.amount || 0) : 0,
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
          additional_details: { quantity: parseInt(product.quantity || 1) },
        },
      ],
    };

    // Step 7️⃣ Call Shadowfax API
    const response = await axios.post(`${SHADOWFAX_BASE_URL}/v3/clients/orders/`, sfxPayload, {
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    const sfxData = response.data;

    if (sfxData.message !== "Success" || !sfxData.data?.awb_number) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: sfxData.errors ? JSON.stringify(sfxData.errors) : (sfxData.message || "Shadowfax order creation failed"),
      };
    }

    // Step 8️⃣ Update Order & Wallet
    await Promise.all([
      Order.findByIdAndUpdate(
        id,
        {
          $set: {
            status: "Booked",
            awb_number: sfxData.data.awb_number,
            provider: "Shadowfax",
            courierName: courierName || "Shadowfax",
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
              StatusLocation: sender.city || "N/A",
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
            awb_number: sfxData.data.awb_number,
            description: "Freight Charges Applied",
            priceBreakup
          }
        ],
        { session }
      )
    ]);

    await session.commitTransaction();
    session.endSession();

    // Auto-assign pickup manifest (non-blocking)
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
      awb_number: sfxData.data.awb_number,
      orderId: currentOrder.orderId,
    };
  } catch (error) {
    await Order.findByIdAndUpdate(id, { status: "new" });
    if (session.inTransaction()) await session.abortTransaction();
    session.endSession();
    return {
      success: false,
      message: "Error creating Shadowfax shipment",
      error: error.message,
    };
  }
};

module.exports = createShadowfaxShipment;
