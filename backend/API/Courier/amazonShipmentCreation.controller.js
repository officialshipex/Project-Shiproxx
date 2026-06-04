const axios = require("axios");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const {
  getAmazonAccessToken,
} = require("../../AllCouriers/Amazon/Authorize/saveCourierController");
const { getZone } = require("../../Rate/zoneManagementController");
const {
  checkAmazonServiceability,
} = require("../../AllCouriers/Amazon/Courier/couriers.controller");
const { s3 } = require("../../config/s3");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const mongoose = require("mongoose");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

/**
 * Creates an Amazon one-click shipment
 * @param {object} params - Shipment parameters
 * @param {string} params.id - Order id
 * @param {string} params.provider - Courier provider
 * @param {number|string} params.finalCharges - Final freight charges
 * @param {string} params.courierServiceName - Courier service name
 * @returns {Promise<object>} Result including success message and AWB number or error details
 */


const createAmazonShipment = async ({
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
  session.startTransaction();

  try {
    console.log("Amazon Shipment Params:", {
      id,
      provider,
      finalCharges,
      courierServiceName,
    });

    // ✅ Get Access Token
    const accessToken = await getAmazonAccessToken();
    if (!accessToken) {
      throw new Error("Access token missing");
    }

    // ✅ Fetch order (with session)
    const currentOrder = await Order.findById(id).session(session).exec();
    if (!currentOrder) throw new Error("Order not found");

    // ✅ Lock order for this transaction (prevents double processing)
    if (currentOrder.status === "Booked") {
      throw new Error("Order already booked");
    }

    // ✅ Get zone
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );
    if (!zone) throw new Error("Pincode not serviceable");

    // ✅ Estimate delivery date
    const eddData = await estimatedDeliveryDate
      .findOne({
        courier: "Amazon Shipping",
        serviceName: courierServiceName.trim(),
      })
      .session(session);

    let estimateDate = null;
    if (eddData) {
      const deliveryDays =
        eddData.zoneRates?.[zone.zone] || eddData[zone.zone] || null;
      if (deliveryDays) {
        estimateDate = new Date();
        estimateDate.setDate(estimateDate.getDate() + deliveryDays);
      }
    }

    const charges = finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
    const holdAmount = walletHoldAmount || 0;
    const availableBalance = walletBalance - holdAmount;
    const balance = availableBalance + walletCreditLimit;

    if (balance < charges)
      throw new Error("Insufficient wallet balance");

    // ✅ Create Amazon shipment (no change here, API call)
    const payload = {
      origin: currentOrder.pickupAddress,
      destination: currentOrder.receiverAddress,
      payment_type: currentOrder.paymentDetails?.method,
      order_amount: currentOrder.paymentDetails?.amount || 0,
      weight: (currentOrder.packageDetails?.applicableWeight || 0) * 1000,
      length: currentOrder.packageDetails.volumetricWeight?.length || 0,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
      height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      productDetails: currentOrder.productDetails,
      orderId: currentOrder.orderId,
    };

    const { rate, requestToken } = await checkAmazonServiceability(
      "Amazon Shipping",
      payload
    );

    const isCOD = payload.payment_type === "COD";

    const shipmentData = {
      requestToken,
      rateId: rate,
      requestedDocumentSpecification: {
        format: "PDF",
        size: { width: 4.0, length: 6.0, unit: "INCH" },
        dpi: 300,
        pageLayout: "DEFAULT",
        needFileJoining: false,
        requestedDocumentTypes: ["LABEL"],
      },
      requestedValueAddedServices: isCOD ? [{ id: "CollectOnDelivery" }] : [],
    };

    const response = await axios.post(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments",
      shipmentData,
      {
        headers: {
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
      }
    );

    const result = response.data?.payload;
    if (!result) throw new Error("Error creating shipment");

    // ✅ Upload label to S3
    const base64Label =
      result.packageDocumentDetails[0].packageDocuments[0].contents;
    const labelBuffer = Buffer.from(base64Label, "base64");
    const labelKey = `labels/${Date.now()}_${currentOrder.orderId || "label"
      }.pdf`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: labelKey,
        Body: labelBuffer,
        ContentType: "application/pdf",
      })
    );

    const labelUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${labelKey}`;

    // ✅ Update order (within session)
    currentOrder.status = "Booked";
    currentOrder.awb_number = result.packageDocumentDetails[0].trackingId;
    currentOrder.shipment_id = result.shipmentId;
    currentOrder.provider = provider || "Amazon Shipping";
    currentOrder.totalFreightCharges = charges;
    currentOrder.courierServiceName = courierServiceName.trim();
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.label = labelUrl;
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimateDate;
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress?.city || "N/A",
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    await currentOrder.save({ session });

    // ✅ Deduct wallet (atomic)
    const transaction = {
      channelOrderId: currentOrder.orderId,
      category: "debit",
      amount: charges,
      date: new Date(),
      awb_number: currentOrder.awb_number,
      description: "Freight Charges Applied",
      balanceAfterTransaction: walletBalance - charges,
      priceBreakup
    };

    await Promise.all([
      Wallet.updateOne(
        { _id: walletId },
        {
          $inc: { balance: -charges },
        },
        { session }
      ),
      WalletTransaction.create(
        [
          {
            walletId: walletId,
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: charges,
            balanceAfterTransaction: walletBalance - charges,
            date: new Date(),
            awb_number: currentOrder.awb_number,
            description: "Freight Charges Applied",
            priceBreakup
          }
        ],
        { session }
      )
    ]);

    // ✅ Commit transaction
    await session.commitTransaction();
    session.endSession();

    // ── Auto-assign pickup manifest (non-blocking) ──
    Order.findById(currentOrder._id)
      .then((freshOrder) => {
        if (freshOrder) assignPickupManifest(freshOrder);
      })
      .catch((pErr) => {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      });

    return {
      success: true,
      message: "Shipment created successfully",
      orderId: currentOrder.orderId,
      awb_number: currentOrder.awb_number,
      shipmentId: result.shipmentId,
      labelUrl,
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    console.error("❌ Amazon Shipment Error:", error.message);
    return {
      success: false,
      message: error.message,
    };
  }
};

module.exports = createAmazonShipment;
