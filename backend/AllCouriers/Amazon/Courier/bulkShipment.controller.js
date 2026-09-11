const axios = require("axios");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getAmazonAccessToken } = require("../Authorize/saveCourierController");
const User = require("../../../models/User.model");
const { s3 } = require("../../../config/s3");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { checkAmazonServiceability } = require("./couriers.controller");
const { getZone } = require("../../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const createShipmentAmazon = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  charges,
  priceBreakup
) => {
  try {
    // console.log("amazon", serviceDetails, orderId, walletId, charges);
    const accessToken = await getAmazonAccessToken();
    if (!accessToken) {
      console.log("accesstoken");
      return { success: false, message: "Access token missing" };
    }

    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) {
      // console.log("order");
      return { success: false, message: "Order not found" };
    }

    // if (currentOrder.status !== "new") {
    //   return {
    //     status: 400,
    //     success: false,
    //     message: `Shipment cannot be created because order status is '${currentOrder.status}'.`,
    //   };
    // }

    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
      // res
    );
    if (!zone) {
      // console.log("sone");
      return { success: false, message: "Pincode not serviceable" };
    }

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Amazon Shipping",
      serviceName: serviceDetails.name.trim(),
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

    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (!currentWallet) {
      return { success: false, message: "Wallet not found" };
    }

    const holdAmount = currentWallet?.holdAmount || 0;
    const availableBalance = currentWallet.balance - holdAmount;
    const balance = availableBalance + currentWallet.creditLimit;
    if (balance < charges) {
      // console.log("balance")
      return {
        success: false,
        message: "Insufficient Wallet Balance",
      };
    }

    const weight = currentOrder.packageDetails?.applicableWeight * 1000;

    const payload = {
      origin: currentOrder.pickupAddress,
      destination: currentOrder.receiverAddress,
      payment_type: currentOrder.paymentDetails?.method,
      gstin: currentOrder?.otherDetails?.gstin,
      order_amount: currentOrder.paymentDetails?.amount || 0,
      weight: weight || 0,
      length: currentOrder.packageDetails.volumetricWeight?.length || 0,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
      height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      productDetails: currentOrder.productDetails,
      orderId: currentOrder.orderId,
    };

    const { rate, requestToken, valueAddedServiceIds } =
      await checkAmazonServiceability("Amazon Shipping", payload);

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
    // console.log("resulttttttttreress", result);
    if (!result) {
      console.log("amazon result");
      return {
        success: false,
        message: "Error creating shipment",
        error: response.data,
      };
    }

    const trackingId = result.packageDocumentDetails[0].trackingId;
    // console.log("tracking", trackingId);
    const base64Label =
      result.packageDocumentDetails[0].packageDocuments[0].contents;
    const labelBuffer = Buffer.from(base64Label, "base64");
    const labelKey = `labels/${Date.now()}_${currentOrder.orderId || "label"
      }.pdf`;

    const uploadCommand = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: labelKey,
      Body: labelBuffer,
      ContentType: "application/pdf",
    });

    await s3.send(uploadCommand);

    const labelUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${labelKey}`;

    // Update Order
    currentOrder.status = "Booked";
    currentOrder.cancelledAtStage = null;
    currentOrder.awb_number = result.packageDocumentDetails[0].trackingId;
    currentOrder.shipment_id = `${result.shipmentId}`;
    currentOrder.provider = "Amazon Shipping";
    currentOrder.totalFreightCharges = parseFloat(charges);
    currentOrder.courierServiceName = serviceDetails.name.trim();
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
    await currentOrder.save();

    // ── Auto-assign pickup manifest ──
    try {
      await assignPickupManifest(currentOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: walletId },
      {
        $inc: { balance: -parseFloat(charges) },
      },
      { new: true }
    );

    await WalletTransaction.create({
      walletId: walletId,
      channelOrderId: currentOrder.orderId,
      category: "debit",
      amount: parseFloat(charges),
      balanceAfterTransaction: updatedWallet ? updatedWallet.balance : (currentWallet.balance - parseFloat(charges)),
      date: new Date(),
      awb_number: result.packageDocumentDetails[0].trackingId,
      description: "Freight Charges Applied",
      priceBreakup
    });

    return {
      success: true,
      message: "Shipment created successfully",
      orderId: currentOrder.orderId,
      waybill: trackingId,
      shipmentId: result.shipmentId,
      labelUrl,
    };
  } catch (error) {
    console.error(
      "❌ Error creating Amazon shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
};

module.exports = { createShipmentAmazon };
