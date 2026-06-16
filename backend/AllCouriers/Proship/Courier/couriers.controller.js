const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const PickupAddress = require("../../../models/pickupAddress.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const { getProshipAccessToken } = require("../Authorize/proship.controller");

const PROSHIP_BASE_URL = "https://proship.prozo.com/api";

const checkProshipServiceability = async (payload) => {
  try {
    const token = await getProshipAccessToken();
    if (!token) return { success: false, message: "Auth failed" };
    // console.log("pickup pincode",payload.pickUpPincode)
    // console.log("drop pincode",payload.deliveryPincode)
    const response = await axios.post(
      `${PROSHIP_BASE_URL}/tools/serviceability`,
      [{
        drop_pincode: parseInt(payload.deliveryPincode),
        pickup_pincode: parseInt(payload.pickUpPincode)
      }],
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000
      }
    );
    // console.log("service", response.data)
    const results = response.data.result || [];
    // console.log("results", results)
    // Filter Shadowfax & DTDC as requested
    const shadowfax = results.find(c => c.name.toLowerCase().includes("shadowfax") || c.account_code.toLowerCase().includes("shadowfax"));
    const dtdc = results.find(c => c.name.toLowerCase().includes("dtdc") || c.account_code.toLowerCase().includes("dtdc"));

    if (shadowfax || dtdc) {
      const courier_ids = [];
      if (shadowfax) courier_ids.push(shadowfax.cp_id);
      if (dtdc) courier_ids.push(dtdc.cp_id);

      return {
        success: true,
        courier_ids: courier_ids,
        couriers: {
          shadowfax: shadowfax ? shadowfax.cp_id : null,
          dtdc: dtdc ? dtdc.cp_id : null
        },
        account_id: (shadowfax || dtdc).account_id
      };
    }

    return { success: false, message: "Shadowfax or DTDC not available" };
  } catch (error) {
    console.error("Proship Serviceability Error:", error.response?.data || error.message);
    return { success: false, error: error.message };
  }
};
// checkProshipServiceability({
//   pickUpPincode: "110001",
//   deliveryPincode: "110002"
// })

const createProshipOrder = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      id,
      finalCharges,
      courierServiceName,
      priceBreakup,
      courier, // selected courier cp_id/name
      estimatedDeliveryDate
    } = req.body;

    session.startTransaction();

    // 1. Atomically lock the order
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
        message: "Shipment already created or order is being processed."
      });
    }

    // 2. Fetch User and Wallet
    const user = await User.findById(currentOrder.userId).session(session);
    if (!user) throw new Error("User not found");

    const currentWallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);
    if (!currentWallet) throw new Error("Wallet not found");

    // 3. Balance Check
    const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0);
    const totalBalance = effectiveBalance + (currentWallet.creditLimit || 0);
    if (totalBalance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // 4. Get Zone
    const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Pincode not serviceable" });
    }

    // 5. Authenticate with Proship
    const token = await getProshipAccessToken();
    if (!token) throw new Error("Proship authentication failed");

    // 6. Construct Proship Payload
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
        from_email: currentOrder.pickupAddress.email || user.email || "info@shiproxx.com",
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

    console.log("Proship Create Order Payload:", JSON.stringify(proshipPayload, null, 2));

    // 7. Call Proship API
    const response = await axios.post(`${PROSHIP_BASE_URL}/order/create`, proshipPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 10000
    });

    console.log("Proship Create Order Response:", response.data);

    if (
      !response.data ||
      !response.data.meta ||
      response.data.meta.status !== "200 OK" ||
      !response.data.result ||
      !response.data.result.awb_number
    ) {
      throw new Error(response.data?.meta?.message || "Proship order creation failed");
    }

    const { awb_number } = response.data.result;

    // 8. Update Order inside transaction
    currentOrder.status = "Booked";
    currentOrder.awb_number = awb_number;
    const sNameForProv = courierServiceName?.toLowerCase() || "";
    currentOrder.provider = sNameForProv.includes("dtdc") ? "Dtdc" : "Shadowfax";
    currentOrder.partner = "Proship";
    currentOrder.shipment_id = response.data.result.id || String(currentOrder.orderId);
    currentOrder.totalFreightCharges = parseFloat(finalCharges) || 0;
    currentOrder.courierServiceName = courierServiceName;
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || "";
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city,
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    // 9. Update Wallet inside transaction
    currentWallet.balance -= finalCharges;
    await WalletTransaction.create([{
      walletId: currentWallet._id,
      channelOrderId: currentOrder.orderId,
      category: "debit",
      amount: finalCharges,
      balanceAfterTransaction: currentWallet.balance,
      awb_number: awb_number,
      description: "Freight Charges Applied",
      priceBreakup,
    }], { session });

    await Promise.all([
      currentOrder.save({ session }),
      currentWallet.save({ session }),
    ]);

    await session.commitTransaction();
    session.endSession();

    // ── Auto-assign pickup manifest ──
    try {
      const freshOrder = await Order.findById(id);
      if (freshOrder) await assignPickupManifest(freshOrder);
    } catch (pErr) {
      console.error("[Pickup] assignPickupManifest failed:", pErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      awb_number: awb_number,
      orderId: currentOrder.orderId
    });

  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();

    // Session transaction abort will automatically roll back the status to "new"

    console.error("Proship Creation Error:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      error: error.response?.data?.meta?.message || error.message,
    });
  }
};

const trackProshipOrder = async (awb) => {
  try {
    const token = await getProshipAccessToken();
    if (!token) return { success: false, message: "Auth failed" };

    const response = await axios.get(
      `${PROSHIP_BASE_URL}/order/track_waybill`,
      {
        params: {
          waybills: awb // can be single or comma-separated string
        },
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 8000
      }
    );

    // console.log("proship tracking", response.data?.waybillDetails?.[0]?.order_history);

    const waybillData = response.data?.waybillDetails?.[0];
    return { success: true, data: waybillData?.order_history || [] };

  } catch (error) {
    console.error("Proship Tracking Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
};
// trackProshipOrder("SF3166239830PRZ")

const cancelProshipOrder = async (awb) => {
  try {
    const token = await getProshipAccessToken();
    if (!token) return { success: false, message: "Auth failed" };

    // Placeholder for Proship Cancellation API
    const response = await axios.post(`${PROSHIP_BASE_URL}/order/cancel_order`, { waybill: awb }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });
    // return response.data;
    console.log("cancel response", response.data)
    return { success: true, message: "Cancelled successfully" };
  } catch (error) {
    console.error("Proship Cancellation Error:", error.message);
    return { success: false, error: error.message };
  }
};


module.exports = { createProshipOrder, checkProshipServiceability, trackProshipOrder, cancelProshipOrder };
