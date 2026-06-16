const axios = require("axios");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const { getProshipAccessToken } = require("../Authorize/proship.controller");

const PROSHIP_BASE_URL = "https://proship.prozo.com/api";

const createOrderProship = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  charges,
  priceBreakup,
  estimatedDeliveryDate = null,
) => {
  try {
    // console.log("order",orderId)
    /* --------------------------------------------------
       1️⃣ FETCH ORDER
    -------------------------------------------------- */
    const currentOrder = await Order.findById(orderId);
    if (!currentOrder) {
      return { success: false, message: "Order not found" };
    }
    // console.log("proship data",serviceDetails)
    /* --------------------------------------------------
       2️⃣ ZONE CHECK
    -------------------------------------------------- */
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    if (!zone) {
      return { success: false, message: "Pincode not serviceable" };
    }

    /* --------------------------------------------------
       3️⃣ WALLET CHECK
    -------------------------------------------------- */
    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (!currentWallet) {
      return { success: false, message: "Wallet not found" };
    }

    const holdAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - holdAmount;
    const balance = effectiveBalance + currentWallet.creditLimit;

    if (balance < charges) {
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    /* --------------------------------------------------
       4️⃣ AUTHENTICATE WITH PROSHIP
    -------------------------------------------------- */
    const token = await getProshipAccessToken();
    if (!token) {
      return { success: false, message: "Failed to get Proship access token" };
    }

    /* --------------------------------------------------
       5️⃣ PROSHIP PAYLOAD
    -------------------------------------------------- */
    const isCOD = currentOrder.paymentDetails.method === "COD";

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
        from_email: currentOrder.pickupAddress.email || "info@shiproxx.com",
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
      cod_amount: isCOD ? currentOrder.paymentDetails.amount : 0,
      client_order_id: String(currentOrder.orderId),
      is_reverse: false,
      invoice_number: String(currentOrder.orderId),
      transaction_charge: 0.0,
      giftwrap_charge: 0.0,
      payment_mode: isCOD ? "COD" : "PREPAID",
      reference: `ORD-${currentOrder.orderId}`,
      channel_name: serviceDetails?.name?.toLowerCase().includes("dtdc")
        ? "dtdc-surface"
        : serviceDetails?.name?.toLowerCase().includes("shadowfax")
          ? "shadowfax-surface"
          : "WMS",
    };

    /* --------------------------------------------------
       6️⃣ PROSHIP API CALL
    -------------------------------------------------- */
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
      return {
        success: false,
        message: response.data?.meta?.message || "Proship shipment failed",
        error: response.data,
      };
    }

    const awb = response.data.result.awb_number;

    /* --------------------------------------------------
       7️⃣ UPDATE ORDER
    -------------------------------------------------- */
    currentOrder.status = "Booked";
    currentOrder.cancelledAtStage = null;
    currentOrder.awb_number = awb;
    currentOrder.shipment_id = response.data.result.id || String(currentOrder.orderId);
    currentOrder.provider = serviceDetails?.name?.toLowerCase().includes("dtdc") ? "Dtdc" : "Shadowfax";
    currentOrder.partner = "Proship";
    currentOrder.totalFreightCharges = parseFloat(charges);
    currentOrder.courierServiceName = serviceDetails.name;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimatedDeliveryDate;
    currentOrder.priceBreakup = priceBreakup;

    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city || "N/A",
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

    /* --------------------------------------------------
       8️⃣ WALLET DEBIT
    -------------------------------------------------- */
    const updatedWallet = await Wallet.findOneAndUpdate(
      { _id: walletId },
      {
        $inc: { balance: -charges },
      },
      { new: true }
    );

    // 🔁 Dual-write: mirror to WalletTransaction for future migration
    if (updatedWallet) {
      await WalletTransaction.create({
        walletId: updatedWallet._id,
        channelOrderId: currentOrder.orderId,
        category: "debit",
        amount: charges,
        balanceAfterTransaction: updatedWallet.balance,
        date: new Date(),
        awb_number: awb,
        description: "Freight Charges Applied",
        priceBreakup,
      });
    }

    /* --------------------------------------------------
        9️⃣ FINAL RETURN
    -------------------------------------------------- */
    return {
      success: true,
      message: "Shipment Created Successfully",
      orderId: currentOrder.orderId,
      waybill: awb,
    };
  } catch (error) {
    console.error(
      "Proship bulk shipment error:",
      error.response?.data || error.message
    );
    return {
      success: false,
      message: "Failed to create shipment",
      error: error.response?.data || error.message,
    };
  }
};

module.exports = { createOrderProship };
