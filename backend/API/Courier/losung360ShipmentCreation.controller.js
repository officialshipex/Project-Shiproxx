const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const { getZone } = require("../../Rate/zoneManagementController");
const { getLosung360AccessToken } = require("../../AllCouriers/Losung360/Authorize/losung360.controller");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const LOSUNG360_BASE_URL = "https://appapi.losung360.com/external/v1";

const createLosung360Shipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  partnerServiceId,
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

    // Step 1: Fetch order & mark as processing
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

    // Step 2: Wallet check
    if (!walletId) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Wallet not found" };
    }

    // Step 3: Wallet Balance Check
    const effectiveBalance = walletBalance - (walletHoldAmount || 0);
    const balanceToBeDeducted = finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
    const totalBalance = effectiveBalance + (walletCreditLimit || 0);
    
    if (totalBalance < balanceToBeDeducted) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // Step 4: Get Zone
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Pincode not serviceable" };
    }

    // Step 5: Fetch estimated delivery date from DB
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Losung360",
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

    // Step 6: Authenticate with Losung360
    const tokenStartTime = Date.now();
    const token = await getLosung360AccessToken();
    const tokenEndTime = Date.now();
    console.log(`⏱️ Losung360 getAccessToken took: ${tokenEndTime - tokenStartTime}ms`);

    if (!token) {
      await Order.findByIdAndUpdate(id, { status: "new" });
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Losung360 authentication failed" };
    }

    // Step 7: Create Order in Losung360
    const channelId = 1082;
    const pickupAddressId = Number(process.env.LOSUNG360_PICKUP_ADDRESS_ID) || 0;

    const orderPayload = {
      pickup_address_id: pickupAddressId,
      channel_id: channelId,
      payment_method: currentOrder.paymentDetails?.method === "COD" ? "cod" : "prepaid",
      order_number: String(currentOrder.orderId),
      customer: {
        name: currentOrder.receiverAddress.contactName || "Customer",
        phone: currentOrder.receiverAddress.phoneNumber?.replace(/^0+/, "") || "9999999999",
        email: currentOrder.receiverAddress.email || "customer@example.com",
        address: currentOrder.receiverAddress.address || "N/A",
        landmark: currentOrder.receiverAddress.landmark || "",
        pincode: String(currentOrder.receiverAddress.pinCode),
        city: currentOrder.receiverAddress.city || "N/A",
        state: currentOrder.receiverAddress.state || "N/A"
      },
      products: currentOrder.productDetails.map(p => ({
        sku: p.sku || `SKU-${currentOrder.orderId}`,
        name: p.name || "Product",
        price: Number(p.unitPrice) || 0,
        quantity: Number(p.quantity) || 1
      })),
      package: {
        weight: Number(currentOrder.packageDetails.applicableWeight) || 0.5,
        length: Number(currentOrder.packageDetails.length) || 10,
        width: Number(currentOrder.packageDetails.width) || 10,
        height: Number(currentOrder.packageDetails.height) || 10
      },
      other_charges: 0,
      total_discount: 0
    };

    console.log("Losung360 Create Order Payload:", JSON.stringify(orderPayload, null, 2));

    const orderStartTime = Date.now();
    const orderResponse = await axios.post(`${LOSUNG360_BASE_URL}/orders/create`, orderPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });
    const orderEndTime = Date.now();
    console.log(`⏱️ Losung360 /orders/create API took: ${orderEndTime - orderStartTime}ms`);
    console.log("Losung360 Create Order Response:", orderResponse.data);

    if (orderResponse.data?.status !== "success" || !orderResponse.data?.data?.order_id) {
      throw new Error(orderResponse.data?.message || "Losung360 order creation failed");
    }

    const externalOrderId = orderResponse.data.data.order_id;

    // Step 8: Create Shipment in Losung360
    const shipmentPayload = {
      order_id: String(externalOrderId)
    };

    if (partnerServiceId) {
      shipmentPayload.carrier_variant_id = Number(partnerServiceId);
    }

    console.log("Losung360 Create Shipment Payload:", JSON.stringify(shipmentPayload, null, 2));

    const shipmentStartTime = Date.now();
    const shipmentResponse = await axios.post(`${LOSUNG360_BASE_URL}/shipping/create-shipment`, shipmentPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });
    const shipmentEndTime = Date.now();
    console.log(`⏱️ Losung360 /shipping/create-shipment API took: ${shipmentEndTime - shipmentStartTime}ms`);
    console.log(`⏱️ Total Losung360 shipment creation APIs combined duration: ${shipmentEndTime - orderStartTime}ms`);
    console.log("Losung360 Create Shipment Response:", shipmentResponse.data);

    if (!shipmentResponse.data || shipmentResponse.data.success !== true || !shipmentResponse.data.awb) {
      throw new Error(shipmentResponse.data?.detail || "Losung360 shipment creation failed");
    }

    const { awb, courier_name, label_url } = shipmentResponse.data;
    const finalProviderName = courier_name ? (courier_name.charAt(0).toUpperCase() + courier_name.slice(1).toLowerCase()) : "Bluedart";

    // Step 9: Update Order & Wallet atomically
    await Promise.all([
      Order.findByIdAndUpdate(
        id,
        {
          $set: {
            status: "Booked",
            cancelledAtStage: null,
            awb_number: awb,
            shipment_id: String(externalOrderId),
            provider: finalProviderName,
            partner: "Losung360",
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
            awb_number: awb || "",
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
      awb_number: awb,
      orderId: currentOrder.orderId,
      estimatedDeliveryDate: estimateDate,
      labelUrl: label_url || null
    };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    await Order.findByIdAndUpdate(id, { status: "new" });
    session.endSession();
    console.error("Losung360 Creation Error:", error.response?.data || error.message);
    return {
      success: false,
      message: error.response?.data?.detail || error.message || "Error creating shipment",
    };
  }
};

module.exports = createLosung360Shipment;
