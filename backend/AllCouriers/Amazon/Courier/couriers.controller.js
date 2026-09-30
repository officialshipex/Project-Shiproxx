const { getAmazonAccessToken } = require("../Authorize/saveCourierController");
const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const User = require("../../../models/User.model");
const { s3 } = require("../../../config/s3");
const { getZone } = require("../../../Rate/zoneManagementController");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { findByPincode } = require("../../../B2B/pincodeLoader");
const {
  markWooOrderAsSihpped,
} = require("../../../Channels/WooCommerce/woocommerce.controller");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const createOneClickShipment = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const accessTokenPromise = getAmazonAccessToken(); // Run early in parallel

    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      estimatedDeliveryDate,
      priceBreakup
    } = req.body;

    // Step 1️⃣ Fetch order and lock it
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session },
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Shipment cannot be created because order is already processed or not in 'new' status.`,
      });
    }

    // Step 2️⃣ Parallel async calls
    const [accessToken, zone, user] = await Promise.all([
      accessTokenPromise,
      getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode,
      ),
      User.findById(currentOrder.userId).session(session),
    ]);

    if (!accessToken) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({ error: "Access token missing" });
    }

    if (!zone) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Pincode not serviceable" });
    }

    if (!user) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Step 3️⃣ Fetch wallet
    const currentWallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);
    if (!currentWallet) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Wallet not found" });
    }

    // Step 4️⃣ Prepare payload (keep as-is)
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

    // Step 5️⃣ Serviceability check
    const { rate, requestToken, valueAddedServiceIds } =
      await checkAmazonServiceability("Amazon", payload);

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
      requestedValueAddedServices: [
        ...(isCOD ? [{ id: "CollectOnDelivery" }] : []),
      ],
    };

    // Step 6️⃣ Wallet check
    const walletHoldAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const balanceToBeDeducted =
      finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < balanceToBeDeducted) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // Step 7️⃣ Amazon Shipment API call (keep as-is)
    const response = await axios.post(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments",
      shipmentData,
      {
        headers: {
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    if (!response?.data?.payload) {
      await Order.findByIdAndUpdate(id, { status: "new" }, { session });
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ message: "Error creating shipment", details: response.data });
    }

    const result = response.data.payload;
    const trackingId = result.packageDocumentDetails[0].trackingId;
    const base64Label =
      result.packageDocumentDetails[0].packageDocuments[0].contents;
    const labelBuffer = Buffer.from(base64Label, "base64");
    const labelKey = `labels/${Date.now()}_${currentOrder.orderId || "label"
      }.pdf`;

    const labelUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${labelKey}`;

    // Step 8️⃣ Update DB atomically (session)
    currentOrder.set({
      status: "Ready To Ship",
      cancelledAtStage: null,
      awb_number: trackingId,
      shipment_id: result.shipmentId,
      provider,
      totalFreightCharges: balanceToBeDeducted,
      courierServiceName,
      shipmentCreatedAt: new Date(),
      label: labelUrl,
      zone: zone.zone,
      estimatedDeliveryDate,
      priceBreakup,
      tracking: [
        ...currentOrder.tracking,
        {
          status: "Ready To Ship",
          StatusLocation: currentOrder.pickupAddress?.city || "N/A",
          StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          Instructions: "Order booked successfully",
        },
      ],
    });

    await Promise.all([
      currentOrder.save({ session }),
      currentWallet.updateOne(
        {
          $inc: { balance: -balanceToBeDeducted },
        },
        { session },
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: labelKey,
          Body: labelBuffer,
          ContentType: "application/pdf",
        }),
      ),
    ]);

    // 🔁 Dual-write: mirror to WalletTransaction for future migration
    await WalletTransaction.create([{
      walletId: currentWallet._id,
      channelOrderId: currentOrder.orderId || null,
      category: "debit",
      amount: balanceToBeDeducted,
      balanceAfterTransaction: currentWallet.balance - balanceToBeDeducted,
      date: new Date(),
      awb_number: trackingId,
      description: "Freight Charges Applied",
      priceBreakup
    }], { session });

    await session.commitTransaction();
    session.endSession();

    // ── Auto-assign pickup manifest ──
    try {
      const freshOrder = await Order.findById(id);
      if (freshOrder) await assignPickupManifest(freshOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    // ✅ Final response
    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      orderId: currentOrder.orderId,
      awb_number: trackingId,
      labelUrl,
    });
  } catch (error) {
    await Order.findByIdAndUpdate(req.body.id, { status: "new" });
    await session.abortTransaction();
    session.endSession();
    console.error(
      "❌ Error creating shipment:",
      error.response?.data || error.message,
    );
    return res.status(500).json({
      success: false,
      message: "Error creating shipment",
      details: error.response?.data || error.message,
    });
  }
};

const cancelShipment = async (shipmentId) => {
  // console.log("shipmet")
  const accessToken = await getAmazonAccessToken();
  // console.log("accessToken",accessToken)
  if (!accessToken) {
    // console.error("Failed to get access token");
    return;
  }
  console.log("shipement", shipmentId);
  const isCancelled = await Order.findOne({
    shipment_id: shipmentId,
    status: "Cancelled",
  });
  if (isCancelled) {
    console.log("order is allready cancelled");
    return {
      success: false,
      error: "Order is allready cancelled",
      code: 400,
    };
  }

  try {
    const response = await axios.put(
      `https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/${shipmentId}/cancel`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
      },
    );

    // await Order.updateOne(
    //   { shipment_id: shipmentId },
    //   { $set: { status: "Cancelled" } }
    // );

    if (response.data.payload) {
      console.log("Shipment Cancelled Successfully", response.data);
      return {
        data: response.data,
        code: 201,
      };
    } else {
      return {
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
        success: false,
      };
    }

    // return response.data; // Amazon returns an empty object on success
  } catch (error) {
    console.error(
      "Error cancelling shipmentttt:",
      error.response?.data || error.message,
    );
    return {
      success: false,
      message: "Failed to cancel shipment",
      error: error.response?.data,
    };
  }
};

// cancelShipment(121212)

const getShipmentTracking = async (trackingId) => {
  const accessToken = await getAmazonAccessToken();
  if (!accessToken) {
    // console.error("Failed to get access token");
    return;
  }

  try {
    const response = await axios.get(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/tracking",
      {
        params: { trackingId: trackingId, carrierId: "ATS" },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
        },
      },
    );
    // console.log("response", response.data.payload.eventHistory);
    // console.log(
    //   "Tracking Information:",
    //   response.data.payload.eventHistory[
    //     response.data.payload.eventHistory.length - 4
    //   ]
    // );
    const remarkData = response.data.payload.summary?.trackingDetailCodes;
    let remark;
    if (
      response.data.payload.eventHistory[
        response.data.payload.eventHistory.length - 1
      ].shipmentType === "FORWARD"
    ) {
      remark = remarkData?.forward?.[0];
    } else {
      remark = remarkData?.returns[1];
    }
    return { success: true, data: response.data.payload.eventHistory, remark };
  } catch (error) {
    console.error(
      "Error fetching tracking information:",
      error.response?.data || error.message,
    );
  }
};
// getShipmentTracking("366282419405");

const getCorrectShipDate = () => {
  const now = new Date();
  let shipDate = new Date(now);
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday

  // If Saturday after 2 PM → move to Monday
  if (day === 6 && hour >= 14) {
    shipDate.setDate(shipDate.getDate() + 2);
  }
  // If Sunday → move to Monday
  else if (day === 0) {
    shipDate.setDate(shipDate.getDate() + 1);
  }
  // Normal case
  else if (hour >= 14) {
    shipDate.setDate(shipDate.getDate() + 1);

    // If next day is Sunday → skip to Monday
    if (shipDate.getDay() === 0) {
      shipDate.setDate(shipDate.getDate() + 1);
    }
  }
  // console.log("shipdate",shipDate.toISOString().replace(/\.\d{3}Z$/, "Z"))
  return shipDate.toISOString().replace(/\.\d{3}Z$/, "Z");
};

const checkAmazonServiceability = async (provider, payload) => {
  try {
    // console.log("payloadprovider", payload);

    const accessToken = await getAmazonAccessToken();
    if (!accessToken) return { success: false, reason: "Missing access token" };

    const shipFrom = {
      name: removeTrailingComma(payload.origin.contactName, 40),
      addressLine1: removeTrailingComma(payload.origin.address, 60),
      city: removeTrailingComma(payload.origin.city, 30),
      stateOrRegion: removeTrailingComma(payload.origin.state, 30),
      postalCode: payload.origin.pinCode,
      countryCode: "IN",
      email: payload.origin.email,
      phoneNumber: payload.origin.phoneNumber,
    };

    const shipTo = {
      name: removeTrailingComma(payload.destination.contactName, 40),
      addressLine1: removeTrailingComma(payload.destination.address, 60),
      city: removeTrailingComma(payload.destination.city, 30),
      stateOrRegion: removeTrailingComma(payload.destination.state, 30),
      postalCode: payload.destination.pinCode,
      countryCode: "IN",
      email: payload.destination.email,
      phoneNumber: payload.destination.phoneNumber,
    };

    const totalQuantity = payload.productDetails.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );
    const weightPerUnit = Math.floor(payload.weight / totalQuantity); // in grams
    const requestBody = {
      shipFrom,
      shipTo,
      shipDate: getCorrectShipDate(),
      packages: [
        {
          dimensions: {
            length: payload.length,
            width: payload.breadth,
            height: payload.height,
            unit: "CENTIMETER",
          },
          weight: {
            value: payload.weight / 1000, // Convert grams to kg
            unit: "KILOGRAM",
          },
          insuredValue: {
            value: payload.order_amount,
            unit: "INR",
          },
          packageClientReferenceId: `${payload.orderId}`,
          items: payload.productDetails.map((item) => ({
            itemValue: {
              value: Number(item.unitPrice),
              unit: "INR",
            },
            quantity: item.quantity,
            weight: {
              unit: "GRAM",
              value: weightPerUnit,
            },
            isHazmat: false,
            invoiceDetails: {
              invoiceDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            },
          })),
        },
      ],
      taxDetails: [
        {
          taxType: "GST",
          taxRegistrationNumber: payload?.gstin || "06FKCPS6109D3Z7",
        },
      ],
      channelDetails: {
        channelType: "EXTERNAL",
      },
      ...(payload.payment_type === "COD" && {
        valueAddedServices: {
          collectOnDelivery: {
            amount: {
              value: payload.order_amount,
              unit: "INR",
            },
          },
        },
      }),
    };

    // console.log(
    //   "body",
    //   requestBody,
    //   requestBody.packages[0].items,
    //   requestBody.packages[0].weight
    // );

    const response = await axios.post(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/rates",
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
      },
    );
    // console.log("response", response.data);
    const rates = response.data.payload.rates || [];
    const ineligibleRates = response.data.payload.ineligibleRates || [];
    // console.log("reat", response.data.payload);

    if (rates.length > 0) {
      const selectedRate = rates[0]; // Use the first rate (or allow user to pick one)

      const valueAddedServiceIds =
        selectedRate.availableValueAddedServiceGroups?.flatMap((group) => {
          // Some APIs return valueAddedServices instead of valueAddedServiceIds
          if (group.valueAddedServiceIds) return group.valueAddedServiceIds;
          if (group.valueAddedServices)
            return group.valueAddedServices.map((vas) => vas.id);
          return [];
        }) || [];

      // console.log("val", valueAddedServiceIds);

      return {
        success: true,
        reason: "Pincodes are serviceable",
        rate: selectedRate.rateId,
        serviceable: true,
        requestToken: response.data.payload.requestToken,
        valueAddedServiceIds, // ✅ include this in return
      };
    } else if (ineligibleRates.length > 0) {
      // console.log("❌ Amazon does not service this pincode.");
      return {
        success: false,
        reason: "Pincodes are not serviceable",
        ineligibleRates,
      };
    } else {
      return { success: false, reason: "No rates returned by Amazon" };
    }
  } catch (error) {
    console.error(
      "Error checking serviceabilityyy:",
      error.response?.data || error.message,
    );
    return { success: false, reason: "Error checking serviceability" };
  }
};

const checkAmazonServiceabilityWithoutOrder = async (
  pickUpPincode,
  deliveryPincode,
  applicableWeight,
  declaredValue,
  paymentType,
  dimensions,
) => {
  try {
    // console.log(
    //   "pickupPincode, deliveryPincode,applicableWeight,declaredValue,paymentType,dimensions",
    //   pickUpPincode,
    //   deliveryPincode,
    //   applicableWeight,
    //   declaredValue,
    //   paymentType,
    //   dimensions,
    // );
    /* ================= ACCESS TOKEN ================= */
    const accessToken = await getAmazonAccessToken();
    // console.log("accessToken", accessToken);
    if (!accessToken) {
      return { success: false, reason: "Missing access token" };
    }
    // console.log("dimensions", dimensions);
    /* ================= PINCODE LOOKUP ================= */
    const pickupData = await findByPincode(pickUpPincode);
    const deliveryData = await findByPincode(deliveryPincode);

    if (!pickupData || !deliveryData) {
      return {
        success: false,
        reason: "Invalid pickup or delivery pincode",
      };
    }

    /* ================= SHIP FROM ================= */
    const shipFrom = {
      name: "Demo Shipper",
      addressLine1: "Warehouse Address Line 1",
      city: pickupData.city,
      postalCode: pickUpPincode,
      stateOrRegion: toTitleCase(pickupData.state),
      countryCode: "IN",
      email: "shipper@test.com",
      phoneNumber: "9999993998",
    };

    /* ================= SHIP TO ================= */
    const shipTo = {
      name: "Demo Customer",
      addressLine1: "Customer Address Line 1",
      city: deliveryData.city,
      postalCode: deliveryPincode,
      stateOrRegion: toTitleCase(deliveryData.state),
      countryCode: "IN",
      email: "customer@test.com",
      phoneNumber: "8888583688",
    };
    const weightInKg = Number(applicableWeight);
    const weightInGram = Math.round(weightInKg * 1000);
    const normalizedDimensions = {
      length: Number(dimensions?.length || 10),
      width: Number(dimensions?.width || dimensions?.breadth || 10),
      height: Number(dimensions?.height || 10),
    };

    /* ================= REQUEST BODY ================= */
    const requestBody = {
      shipFrom,
      shipTo,
      shipDate: getCorrectShipDate(),
      packages: [
        {
          dimensions: {
            length: normalizedDimensions.length,
            width: normalizedDimensions.width,
            height: normalizedDimensions.height,
            unit: "CENTIMETER",
          },
          weight: {
            value: weightInKg, // ✅ 1 KG
            unit: "KILOGRAM",
          },
          insuredValue: {
            value: Number(declaredValue),
            unit: "INR",
          },
          packageClientReferenceId: `SRV-${Date.now()}`,
          items: [
            {
              itemValue: {
                value: Number(declaredValue),
                unit: "INR",
              },
              quantity: 1,
              weight: {
                value: weightInGram, // ✅ 1000 GRAM (matches package)
                unit: "GRAM",
              },
              isHazmat: false,
              invoiceDetails: {
                invoiceDate: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
              },
            },
          ],
        },
      ],

      taxDetails: [
        {
          taxType: "GST",
          taxRegistrationNumber: "06FKCPS6109D3Z7", // demo GST
        },
      ],

      channelDetails: {
        channelType: "EXTERNAL",
      },

      ...(paymentType === "COD" && {
        valueAddedServices: {
          collectOnDelivery: {
            amount: {
              value: declaredValue,
              unit: "INR",
            },
          },
        },
      }),
    };

    /* ================= AMAZON API CALL ================= */
    const response = await axios.post(
      "https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/rates",
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-amz-access-token": accessToken,
          "x-amzn-shipping-business-id": "AmazonShipping_IN",
          "Content-Type": "application/json",
        },
      },
    );

    const {
      rates = [],
      ineligibleRates = [],
      requestToken,
    } = response.data?.payload || {};
    // console.log("amazon serviceability response", response.data.payload);
    /* ================= RESPONSE ================= */
    if (rates.length > 0) {
      const selectedRate = rates[0];

      const valueAddedServiceIds =
        selectedRate.availableValueAddedServiceGroups?.flatMap((group) => {
          if (group.valueAddedServiceIds) return group.valueAddedServiceIds;
          if (group.valueAddedServices)
            return group.valueAddedServices.map((v) => v.id);
          return [];
        }) || [];

      return {
        success: true,
        serviceable: true,
        reason: "Pincodes are serviceable",
        rateId: selectedRate.rateId,
        requestToken,
        valueAddedServiceIds,
      };
    }

    if (ineligibleRates.length > 0) {
      return {
        success: false,
        serviceable: false,
        reason: "Pincodes are not serviceable",
        ineligibleRates,
      };
    }
    console.log(
      "❌ Amazon does not service this pincode.",
      rates,
      ineligibleRates,
    );
    return {
      success: false,
      reason: "No rates returned by Amazon",
    };
  } catch (error) {
    console.log(
      "❌ Error checking serviceability:",
      error.response?.data || error.message,
    );
    return {
      success: false,
      reason: "Error checking serviceability",
      error: error.response?.data || error.message,
    };
  }
};

const toTitleCase = (str = "") =>
  str
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

const removeTrailingComma = (value, maxLength = 60) => {
  if (!value) return "";

  return value
    .toString()
    .replace(/,+$/, "") // ✅ removes ONLY comma(s) at the END
    .trimEnd() // ✅ removes trailing spaces
    .slice(0, maxLength);
};

module.exports = {
  createOneClickShipment,
  cancelShipment,
  getShipmentTracking,
  checkAmazonServiceability,
  checkAmazonServiceabilityWithoutOrder,
};
