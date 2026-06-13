const express = require("express");
const axios = require("axios");
const User = require("../../../models/User.model");
require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getDTDCAuthToken } = require("../Authorize/saveCourierContoller");
const { getZone } = require("../../../Rate/zoneManagementController");
const commodityOptions = require("../../../config/commodityOptions");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const {
  markWooOrderAsShipped,
} = require("../../../Channels/WooCommerce/woocommerce.controller");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
// const router = express.Router();

// DTDC API Configuration from environment variables
const DTDC_API_URL = process.env.DTDC_API_URL;
const API_KEY = process.env.DTDC_API_KEY;
const X_ACCESS_TOKEN = process.env.DTDC_X_ACCESS_TOKEN;

// Create a new shipment
const createOrder = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      id,
      provider,
      finalCharges,
      courierServiceName,
      courier,
      estimatedDeliveryDate,
      priceBreakup
    } = req.body;

    if (!courier) {
      return res.status(400).json({
        success: false,
        message: "service_type_id missing please refresh your page",
      });
    }

    session.startTransaction();

    // --- Fetch & lock Order atomically ---
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Shipment cannot be created because order is already processed or not in 'new' status.`,
      });
    }

    // --- Parallel fetch zone and user ---
    const [zone, user] = await Promise.all([
      getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      ),
      User.findById(currentOrder.userId).session(session),
    ]);

    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Pincode not serviceable" });
    }

    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const currentWallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);
    if (!currentWallet) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });
    }

    // --- Wallet check ---
    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    const productNames = currentOrder.productDetails
      .map((product) => product.name)
      .join(", ");

    // Detect commodity_id based on product name
    const lowerCaseProductNames = productNames.toLowerCase();
    let commodityId = "Others";
    for (const option of commodityOptions) {
      if (lowerCaseProductNames.includes(option.name.toLowerCase())) {
        commodityId = option.id;
        break;
      }
    }

    // Construct shipment payload
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
          eway_bill:
            currentOrder?.paymentDetails?.amount >= 50000
              ? currentOrder?.otherDetails?.ewaybill
              : "",
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

          // Ensure COD mode is correctly set
          cod_collection_mode: codCollectionMode,
          cod_amount: codAmount,

          ...(courierServiceName === "Dtdc Air" && {
            commodity_id: commodityId,
          }),
          reference_number: "",
        },
      ],
    };
    // console.log(
    //   "consignments",
    //   shipmentData,
    //   shipmentData.consignments[0].origin_details,
    //   shipmentData.consignments[0].destination_details
    // );

    // --- Create shipment API call ---
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
        }
      );
    } catch (shipmentErr) {
      await session.abortTransaction();
      session.endSession();
      console.error(
        "❌ DTDC Shipment API failed:",
        shipmentErr.response?.data || shipmentErr.message
      );
      return res.status(500).json({
        success: false,
        message: shipmentErr.response?.data?.message || "Shipment failed",
        error: shipmentErr.response?.data || shipmentErr.message,
      });
    }

    const result = response?.data?.data?.[0];
    console.log("reslt", result)
    if (!result?.success) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: result?.message || "Shipment failed",
      });
    }

    // --- Update Order inside transaction ---
    const balanceToBeDeducted = parseFloat(finalCharges) || 0;

    await Order.findByIdAndUpdate(
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
          estimatedDeliveryDate: estimatedDeliveryDate || "",
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
      { session, new: true }
    );

    await session.commitTransaction();
    session.endSession();

    // ── Auto-assign pickup manifest ──
    try {
      const freshOrder = await Order.findById(id);
      if (freshOrder) await assignPickupManifest(freshOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    // --- Early response ---
    res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      awb_number: result.reference_number,
      orderId: currentOrder.orderId
    });

    // --- Wallet update (background, safe) ---
    process.nextTick(async () => {
      try {
        await Wallet.findOneAndUpdate(
          { _id: user.Wallet },
          {
            $inc: { balance: -balanceToBeDeducted },
          }
        );
        // 🔁 Dual-write: mirror to WalletTransaction for future migration
        await WalletTransaction.create({
          walletId: user.Wallet,
          channelOrderId: currentOrder.orderId || null,
          category: "debit",
          amount: balanceToBeDeducted,
          balanceAfterTransaction: currentWallet.balance - balanceToBeDeducted,
          date: new Date(),
          awb_number: result.reference_number || "",
          description: "Freight Charges Applied",
          priceBreakup
        });
      } catch (err) {
        console.error("Wallet update error:", err.message);
      }
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error(
      "❌ Error creating shipment:",
      error.response?.data || error.message
    );
    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    });
  }
};

// DTDC API Configuration from environment variables
const DTDC_CANCEL_API_URL = `${DTDC_API_URL}/customer/integration/consignment/cancel`;

// Cancel a shipment
const cancelOrderDTDC = async (AWBNo) => {
  try {
    // Validate inputs
    if (!AWBNo || typeof AWBNo !== "string" || AWBNo.trim() === "") {
      return {
        success: false,
        message: "AWBNo is required and should be a non-empty string.",
      };
    }

    const isCancelled = await Order.findOne({
      awb_number: AWBNo,
      status: "Cancelled",
    });

    if (isCancelled) {
      console.log("Order is already cancelled");
      return {
        error: "Order is already cancelled",
        code: 400,
        success: false,
      };
    }

    const customerCode = "GL9711"; // Hardcoded customer code

    const requestData = { AWBNo: [AWBNo], customerCode }; // Convert AWBNo string to an array
    console.log("Cancel Order Request Data:", requestData);

    // API Call with Proper Authorization Header
    const response = await axios.post(DTDC_CANCEL_API_URL, requestData, {
      headers: {
        "Content-Type": "application/json",
        "api-key": API_KEY,
      },
    });

    // await Order.updateOne(
    //   { awb_number: AWBNo },
    //   { $set: { status: "Cancelled" } }
    // );

    console.log("DTDC Cancel Response:", response.data);
    if (response?.data?.success) {
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
  } catch (error) {
    console.error(
      "Error canceling shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      message: "Failed to cancel shipment",
      error: error.response?.data || error.message,
    };
  }
};
// cancelOrderDTDC("7G1187224")

// DTDC Tracking API Config
const DTDC_TRACKING_API_URL = `https://blktracksvc.dtdc.com/dtdc-api/rest/JSONCnTrk/getTrackDetails`;

// Track Order Controller
const trackOrderDTDC = async (AWBNo) => {
  const access_key = await getDTDCAuthToken();
  // console.log(access_key)
  try {
    const requestData = {
      trkType: "cnno",
      strcnno: AWBNo,
      addtnlDtl: "Y",
    };

    const response = await axios.post(DTDC_TRACKING_API_URL, requestData, {
      headers: {
        "Content-Type": "application/json",
        "x-access-token": access_key,
      },
    });
    // console.log(response.data);
    return { success: true, data: response.data.trackDetails };
  } catch (error) {
    // console.error(
    //   "Error tracking shipment:",
    //   error.response?.data || error.message
    // );
    return {
      success: false,
      error: error.response.message,
      status: 500,
    };
  }
};
// trackOrderDTDC('7G1187613');

const checkServiceabilityDTDC = async (
  originPincode,
  destinationPincode,
  paymentType
) => {
  try {
    if (!originPincode || !destinationPincode) {
      return {
        success: false,
        error: "Both origin and destination pincodes are required.",
      };
    }

    // API Request Body
    const requestBody = {
      orgPincode: originPincode,
      desPincode: destinationPincode,
    };

    const response = await axios.post(
      "http://smarttrack.ctbsplus.dtdc.com/ratecalapi/PincodeApiCall",
      requestBody,
      { headers: { "Content-Type": "application/json" } }
    );

    const data = response.data;
    // console.log("data", response);
    const zipCodeResponse = data.ZIPCODE_RESP || [];
    const serviceList = data.SERV_LIST?.[0] || {};

    if (zipCodeResponse.length === 0) {
      return { success: false, error: "No serviceability data found" };
    }

    const originResponses = zipCodeResponse.filter(
      (resp) => resp.ORGPIN === originPincode
    );
    const destinationResponses = zipCodeResponse.filter(
      (resp) => resp.DESTPIN === destinationPincode
    );

    const isOriginServiceable =
      originResponses.length > 0 &&
      originResponses.every(
        (resp) => resp.MESSAGE === "SUCCESS" && resp.SERVFLAG === "Y"
      );

    const isDestinationServiceable =
      destinationResponses.length > 0 &&
      destinationResponses.every(
        (resp) => resp.MESSAGE === "SUCCESS" && resp.SERVFLAG === "Y"
      );

    // ✅ Check based on payment type
    let isPaymentTypeServiceable = false;

    if (paymentType?.toUpperCase() === "COD") {
      isPaymentTypeServiceable =
        serviceList.COD_Serviceable === "YES" &&
        serviceList.b2C_COD_Serviceable === "YES";
      // serviceList.b2B_COD_Serviceable === "YES";
    } else {
      // prepaid order
      isPaymentTypeServiceable = serviceList.b2C_SERVICEABLE === "YES";
      // serviceList.b2B_SERVICEABLE === "YES";
    }

    const isServiceable =
      isOriginServiceable &&
      isDestinationServiceable &&
      isPaymentTypeServiceable;

    return {
      success: isServiceable,
      type: paymentType,
      details: {
        originServiceable: isOriginServiceable,
        destinationServiceable: isDestinationServiceable,
        paymentTypeServiceable: isPaymentTypeServiceable,
      },
    };
  } catch (error) {
    console.error("Error checking DTDC serviceability:", error.message);
    return { success: false, error: "Error checking serviceability" };
  }
};

module.exports = {
  createOrder,
  cancelOrderDTDC,
  trackOrderDTDC,
  checkServiceabilityDTDC,
};
