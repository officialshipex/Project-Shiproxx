const express = require("express");
const axios = require("axios");
const User = require("../../../models/User.model");
require("dotenv").config();
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getDTDCAuthToken } = require("../Authorize/saveCourierContoller");
const { getZone } = require("../../../Rate/zoneManagementController");
const CourierService = require("../../../models/CourierService.Schema");
const commodityOptions = require("../../../config/commodityOptions");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
// const router = express.Router();

// DTDC API Configuration from environment variables
const DTDC_API_URL = process.env.DTDC_API_URL;
const API_KEY = process.env.DTDC_API_KEY;
const X_ACCESS_TOKEN = process.env.DTDC_X_ACCESS_TOKEN;

// Create a new shipment
const createOrderDTDC = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  charges,
  priceBreakup
) => {
  try {
    console.log("API Key:", API_KEY);
    console.log("Access Token:", X_ACCESS_TOKEN);

    // Fetch order, user, and wallet details
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) {
      return { success: false, message: "Order not found" };
    }
    const service = await CourierService.findOne({ name: serviceDetails.name });

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
      return { success: false, message: "Pincode not serviceable" };
    }

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Dtdc",
      serviceName: serviceDetails.name,
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
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < charges) {
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    const productNames = currentOrder.productDetails
      .map((product) => product.name)
      .join(", "); // Convert array to a comma-separated string

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
          service_type_id: service.courier,
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

          ...(serviceDetails.name === "Dtdc Air" && {
            commodity_id: commodityId,
          }),
          reference_number: "",
        },
      ],
    };

    // API call to DTDC
    let response;
    // if (currentWallet.balance >= finalCharges) {
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
    console.log("response dtdc", response.data);
    // } else {
    // return res.status(400).json({ success: false, message: "Low Balance" });
    // }
    if (response?.data?.data[0]?.success) {
      const result = response.data.data[0];
      currentOrder.status = "Ready To Ship";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.reference_number;
      currentOrder.shipment_id = `${result.customer_reference_number}`;
      currentOrder.provider = serviceDetails.provider;
      currentOrder.totalFreightCharges = parseFloat(charges);
      currentOrder.courierServiceName = serviceDetails.name;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.estimatedDeliveryDate = estimateDate;
      currentOrder.zone = zone.zone;
      currentOrder.priceBreakup = priceBreakup;
      currentOrder.tracking.push({
        status: "Ready To Ship",
        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        Instructions: "Order booked successfully",
      });
      let savedOrder = await currentOrder.save();

      // ── Auto-assign pickup manifest ──
      try {
        await assignPickupManifest(currentOrder);
      } catch (pErr) {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      }

      // console.log("sjakjska",balanceToBeDeducted)
      // Deduct wallet balance using atomic operation and update transaction
      const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: walletId },
        {
          $inc: { balance: -charges },
        },
        { new: true }
      );
      // 🔁 Dual-write: mirror to WalletTransaction for future migration
      await WalletTransaction.create({
        walletId: walletId,
        channelOrderId: currentOrder.orderId,
        category: "debit",
        amount: charges,
        balanceAfterTransaction: currentWallet.balance - parseFloat(charges),
        date: new Date(),
        awb_number: result.reference_number,
        description: "Freight Charges Applied",
        priceBreakup
      });
    } else {
      console.log("ererer", response.data);
      return { message: "Error creating shipment" };
    }

    console.log("res data", response.data.data);

    return {
      message: "Shipment Created Successfully",
      success: true,
      orderId: currentOrder.orderId,
      waybill: response.data.data[0].reference_number,
    };
  } catch (error) {
    console.error(
      "Error creating shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    };
  }
};

module.exports = { createOrderDTDC };
