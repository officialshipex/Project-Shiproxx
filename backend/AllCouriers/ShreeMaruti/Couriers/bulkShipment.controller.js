if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const axios = require("axios");
const { getToken } = require("../Authorize/shreeMaruti.controller");

const Services = require("../../../models/CourierService.Schema");
const Order = require("../../../models/newOrder.model");
const { getUniqueId } = require("../../getUniqueId");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const BASE_URL = process.env.SHREEMA_PRODUCTION_URL;

const createShipmentFunctionShreeMaruti = async (
  selectedServiceDetails,
  orderId,
  wh,
  walletId,
  finalCharges,
  priceBreakup
) => {
  const API_URL = `${BASE_URL}/fulfillment/public/seller/order/ecomm/push-order`;

  try {
    const token = await getToken();
    const currentOrder = await Order.findById(orderId);

    // if (currentOrder.status !== "new") {
    //   return {
    //     status: 400,
    //     success: false,
    //     message: `Shipment cannot be created because order status is '${currentOrder.status}'.`,
    //   };
    // }

    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
      // res
    );
    const services = await Services.findOne({
      name: selectedServiceDetails.name,
    });
    // console.log("zone", zone);
    if (!zone) {
      return { success: false, message: "Pincode not serviceable" };
    }

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Shree Maruti",
      serviceName: selectedServiceDetails.name,
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

    function sanitizeAddress(str) {
      if (!str) return "";
      return str
        .replace(/[^a-zA-Z0-9\s,\/.\-#&]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function normalizeState(state) {
      if (!state) return "";

      const cleaned = state
        .replace(/[^a-zA-Z\s]/g, "")
        .trim()
        .toLowerCase();

      if (
        cleaned === "jammu kashmir" ||
        cleaned === "jammu and kashmir" ||
        cleaned === "jammu  kashmir" ||
        cleaned === "jammu   kashmir"
      ) {
        return "Jammu and Kashmir";
      }

      return state.trim();
    }

    // Prepare order items
    const lineItems = Array.from(
      { length: currentOrder.productDetails.length },
      (_, index) => {
        const item = currentOrder.productDetails[index];

        return {
          name: item.name,
          quantity: Number(item.quantity) || 0, // Ensure it's a number, default to 0 if invalid
          price: Number(item.unitPrice) * Number(item.quantity) || 0, // Ensure valid price
          unitPrice: Number(item.unitPrice) || 0, // Ensure valid unit price
          weight: currentOrder.packageDetails?.applicableWeight
            ? Math.max(
              Number(currentOrder.packageDetails.applicableWeight) * 1000,
              1
            )
            : 1,
          sku: item.sku || null,
        };
      }
    );

    // Payment and shipment details
    const payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "ONLINE";
    const payment_status =
      currentOrder.paymentDetails.method === "COD" ? "PENDING" : "PAID";

    // Construct payload
    const payload = {
      orderId: `${currentOrder.orderId}`,
      orderSubtype: "FORWARD",
      currency: "INR",
      amount: parseInt(currentOrder.paymentDetails.amount),
      weight: Number(currentOrder.packageDetails.applicableWeight) * 1000 || 1,
      lineItems: lineItems,
      paymentType: payment_type,
      paymentStatus: payment_status,
      length:
        Number(currentOrder.packageDetails?.volumetricWeight?.length) || 1,
      height:
        Number(currentOrder.packageDetails?.volumetricWeight?.height) || 1,
      width: Number(currentOrder.packageDetails?.volumetricWeight?.width) || 1,
      billingAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: sanitizeAddress(currentOrder.pickupAddress.address),
        // address2: currentOrder.Biling_details.address2,
        city: sanitizeAddress(currentOrder.pickupAddress.city),
        state: normalizeState(currentOrder.pickupAddress.state),
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      shippingAddress: {
        name: `${currentOrder.receiverAddress.contactName}`,
        phone: currentOrder.receiverAddress.phoneNumber.toString(),
        address1: sanitizeAddress(currentOrder.receiverAddress.address),
        // address2: currentOrder.receiverAddress.address2,
        city: sanitizeAddress(currentOrder.receiverAddress.city),
        state: normalizeState(currentOrder.receiverAddress.state),
        country: "India",
        zip: `${currentOrder.receiverAddress.pinCode}`,
      },
      pickupAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: sanitizeAddress(currentOrder.pickupAddress.address),
        // address2: wh.addressLine2,
        city: sanitizeAddress(currentOrder.pickupAddress.city),
        state: normalizeState(currentOrder.pickupAddress.state),
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      returnAddress: {
        name: `${currentOrder.pickupAddress.contactName}`,
        phone: currentOrder.pickupAddress.phoneNumber.toString(),
        address1: sanitizeAddress(currentOrder.pickupAddress.address),
        // address2: wh.addressLine2,
        city: sanitizeAddress(currentOrder.pickupAddress.city),
        state: normalizeState(currentOrder.pickupAddress.state),
        country: "India",
        zip: `${currentOrder.pickupAddress.pinCode}`,
      },
      selectedCarriers: [
        {
          shortName: "SMILE",
        },
      ],
      deliveryPromise:
        services.courierType === "Domestic (Surface)" ? "SURFACE" : "AIR",
    };

    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < finalCharges) {
      return { success: false, message: "Insufficient Wallet Balance" };
    }
    // console.log("payload",payload)
    // API request
    const response = await axios.post(API_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: 30000,
    });
    console.log("ShreeMaruti Response:", response.data);
    // Handle response
    if (response.status === 200) {
      const result = response.data.data;
      currentOrder.status = "Booked";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awbNumber;
      currentOrder.shipment_id = `${result.shipperOrderId}`;
      currentOrder.provider = selectedServiceDetails.provider;
      currentOrder.totalFreightCharges = parseFloat(finalCharges);
      currentOrder.courierServiceName = selectedServiceDetails.name;
      currentOrder.shipmentCreatedAt = new Date();
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
          $inc: { balance: -parseFloat(finalCharges) },
        },
        { new: true }
      );

      // 🔁 Dual-write: mirror to WalletTransaction for future migration
      if (updatedWallet) {
        await WalletTransaction.create({
          walletId: updatedWallet._id,
          channelOrderId: currentOrder.orderId,
          category: "debit",
          amount: parseFloat(finalCharges),
          balanceAfterTransaction: updatedWallet.balance,
          date: new Date(),
          awb_number: result.awbNumber,
          description: "Freight Charges Applied",
          priceBreakup
        });
      }

      // --- Call Manifest API ---
      try {
        const manifestResponse = await axios.post(
          `${BASE_URL}/fulfillment/public/seller/order/create-manifest`,
          {
            awbNumber: [result.awbNumber], // Order AWB
            // cAwbNumber: result.cAwbNumber || "", // Courier AWB (if available)
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          }
        );

        console.log("Manifest Created:", manifestResponse.data);
      } catch (manifestErr) {
        console.error(
          "Error creating manifest:",
          manifestErr.response?.data || manifestErr.message
        );
        // You can decide whether to fail here or just log and continue
      }

      return {
        status: 201,
        success: true,
        message: "Shipment Created Successfully",
      };
    } else {
      return {
        status: 400,
        success: false,
        error: "Error creating shipment",
        // details: response.data,
      };
    }
  } catch (error) {
    console.log("data", error.response.data);
    console.log("message", error.response.data.message);
    console.log(error.response.data.trace);
    console.error("Error in creating shipment:", error.message);
    return {
      status: 400,
      success: false,
      error: "Error creating shipment",
      // details: response.data,
    };
  }
};

module.exports = { createShipmentFunctionShreeMaruti };
