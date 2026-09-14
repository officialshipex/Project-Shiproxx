const axios = require("axios");
require("dotenv").config();
const { getAccessToken } = require("../Authorize/smartShip.controller");
const Order = require("../../../models/newOrder.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const User = require("../../../models/User.model");
const PickupAddress = require("../../../models/pickupAddress.model");
const https = require("https");
const mongoose = require("mongoose");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const registerSmartshipHub = async (userId, pinCode) => {
  try {
    const pickupAddress = await PickupAddress.findOne({
      userId,
      "pickupAddress.pinCode": pinCode,
    });
    // console.log("pickup", pickupAddress);
    if (!pickupAddress) {
      return {
        success: false,
      };
    }

    if (pickupAddress.smartshipHubId) {
      // console.log("✅ Smartship Hub already registered:", pickupAddress.smartshipHubId);
      return {
        // success: true,
        hubId: pickupAddress.smartshipHubId,
        // message: "Smartship Hub already registered for this pincode",
      };
    }

    const { pickupAddress: addr } = pickupAddress;

    const hubPayload = {
      hub_details: {
        hub_name: addr.contactName || "Warehouse",
        pincode: addr.pinCode,
        city: addr.city,
        state: addr.state,
        address1: addr.address,
        hub_phone: addr.phoneNumber,
        delivery_type_id: 2,
      },
    };
    // console.log(hubPayload);
    const accessToken = await getAccessToken();

    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/hubRegistration",
      hubPayload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const hubId = response?.data?.data?.hub_id;

    if (!hubId) {
      throw new Error("Smartship Hub ID not returned");
    }

    pickupAddress.smartshipHubId = hubId;
    await pickupAddress.save();

    // console.log("✅ Smartship Hub registered and saved:", hubId);

    return {
      // success: true,
      hubId,
      // message: "Smartship Hub registered successfully",
    };
  } catch (err) {
    console.error("❌ Hub Registration Failed:", err.message || err);
    return {
      success: false,
      error: err.message || err,
    };
  }
};

// Reuse persistent HTTPS connection
const httpsAgent = new https.Agent({ keepAlive: true });
axios.defaults.httpsAgent = httpsAgent;

// Optional: simple in-memory cache for zone lookup
const zoneCache = new Map();
const getCachedZone = async (from, to) => {
  const key = `${from}-${to}`;
  if (zoneCache.has(key)) return zoneCache.get(key);
  const zone = await getZone(from, to);
  if (zone) zoneCache.set(key, zone);
  return zone;
};

const orderRegistrationOneStep = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      id,
      finalCharges,
      courierServiceName,
      provider,
      estimatedDeliveryDate,
    } = req.body;

    console.log("req.body", req.body);

    // ✅ Lock order for processing
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
        message:
          "Shipment already created or order is being processed by another request.",
      });
    }

    // ✅ Parallel fetch (fast)
    const [zone, user, accessToken] = await Promise.all([
      getCachedZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      ),
      User.findById(currentOrder.userId),
      getAccessToken(),
    ]);

    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Pincode not serviceable" });
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

    const effectiveBalance =
      currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = currentWallet.balance + currentWallet.creditLimit;
    if (balance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // ✅ Register hub
    const smartshipHub = await registerSmartshipHub(
      user._id,
      currentOrder.pickupAddress.pinCode
    );
    if (smartshipHub?.success === false) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message:
          "Pickup pincode not registered. Please add a pickup address first.",
      });
    }

    // ✅ Build payload
    const payload = {
      request_info: { run_type: "create" },
      orders: [
        {
          client_order_reference_id: currentOrder.orderId,
          shipment_type: 1,
          order_collectable_amount:
            currentOrder.paymentDetails.method === "COD"
              ? currentOrder.paymentDetails.amount
              : 0,
          total_order_value: currentOrder.paymentDetails.amount.toString(),
          payment_type: currentOrder.paymentDetails.method.toLowerCase(),
          package_order_weight: (
            currentOrder.packageDetails.applicableWeight * 1000
          ).toString(),
          package_order_length:
            currentOrder.packageDetails.volumetricWeight.length.toString(),
          package_order_height:
            currentOrder.packageDetails.volumetricWeight.height.toString(),
          package_order_width:
            currentOrder.packageDetails.volumetricWeight.width.toString(),
          shipper_hub_id: smartshipHub.hubId || "",
          order_invoice_date: new Date().toISOString().slice(0, 10),
          order_invoice_number: `INV-${currentOrder.orderId}-${Date.now()}`,
          is_return_qc: "0",
          return_reason_id: "0",
          order_meta: { preferred_carriers: [279] },
          product_details: currentOrder.productDetails.map((p) => ({
            client_product_reference_id: p._id.toString(),
            product_name: p.name,
            product_category: p.category || "General",
            product_hsn_code: p.hsn || "0000",
            product_quantity: p.quantity || 1,
            product_gst_tax_rate: p.gst || "0",
            product_invoice_value: p.unitPrice.toString(),
          })),
          consignee_details: {
            consignee_name: currentOrder.receiverAddress.contactName,
            consignee_phone: currentOrder.receiverAddress.phoneNumber,
            consignee_email:
              currentOrder.receiverAddress.email || "noemail@example.com",
            consignee_complete_address: currentOrder.receiverAddress.address,
            consignee_pincode: currentOrder.receiverAddress.pinCode,
          },
        },
      ],
    };

    // ✅ Smartship API call
    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/orderRegistrationOneStep",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const respData = response.data?.data;
    console.log("Smartship Response:", respData);

    if (respData?.errors) throw new Error("Smartship returned errors");

    if (
      !respData?.success_order_details?.orders?.length &&
      respData?.duplicate_orders
    ) {
      throw new Error("Duplicate orderId not allowed for this courier");
    }

    const result = respData?.success_order_details?.orders?.[0];
    if (!result?.awb_number) throw new Error("AWB not received from Smartship");

    // ✅ Commit response early for better UX
    res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      orderId: currentOrder.orderId,
      awb_number: result.awb_number
    });

    // ✅ Continue in background safely
    // findByIdAndUpdate (not updateOne) — the order model's post-hook that
    // pushes the booking/status back to Shopify only fires on "save" and
    // "findOneAndUpdate" queries, not on updateOne. Using updateOne here
    // meant every SmartShip booking silently never synced to Shopify at all.
    await Order.findByIdAndUpdate(
      currentOrder._id,
      {
        $set: {
          status: "Booked",
          awb_number: result.awb_number,
          shipment_id: result.request_order_id || "",
          provider,
          totalFreightCharges: parseFloat(finalCharges),
          courierServiceName,
          shipmentCreatedAt: new Date(),
          zone: zone.zone,
          estimatedDeliveryDate,
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
    );

    await Wallet.updateOne(
      { _id: currentWallet._id },
      {
        $inc: { balance: -parseFloat(finalCharges) },
      },
      { session }
    );

    // 🔁 Dual-write: mirror to WalletTransaction for future migration
    await WalletTransaction.create([{
      walletId: currentWallet._id,
      channelOrderId: currentOrder.orderId,
      category: "debit",
      amount: parseFloat(finalCharges),
      balanceAfterTransaction: currentWallet.balance - parseFloat(finalCharges),
      date: new Date(),
      awb_number: result.awb_number,
      description: "Freight Charges Applied",
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
  } catch (error) {
    console.error("Smartship Order Registration Error:", error.message);

    try {
      await session.abortTransaction();
      session.endSession();

      // Revert order to 'new' if processing failed
      if (req.body?.id) {
        await Order.updateOne(
          { _id: req.body.id, status: "processing" },
          { $set: { status: "new" } }
        );
      }
    } catch { }

    return res.status(500).json({
      success: false,
      message: "Failed to register order",
      error: error?.response?.data || error.message,
    });
  }
};

const checkSmartshipHubServiceability = async (payload) => {
  try {
    const accessToken = await getAccessToken();

    const requestBody = {
      order_info: {
        source_pincode: payload.source_pincode,
        destination_pincode: payload.destination_pincode,
        order_weight: payload.order_weight || 0.5,
        order_value: payload.order_value || 100,
        preferred_carriers: [1, 3, 279],
        delivery_type: 1,
      },
      request_info: {
        extra_info: false,
        cost_info: false,
      },
    };

    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/ServiceabilityHubWise",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    // console.log("Smartship Serviceability Response:", response.data);

    const serviceabilityData = response.data?.data;
    const serviceable = serviceabilityData?.serviceability_status === true;

    return {
      success: serviceable,
      data: serviceabilityData || {},
    };
  } catch (err) {
    // console.error(
    //   "Smartship Serviceability Error:",
    //   err.response?.data || err.message
    // );
    return {
      success: false,
      error: err.response?.data || err.message,
    };
  }
};

const cancelSmartshipOrder = async (client_order_reference_id) => {
  try {
    if (!client_order_reference_id) {
      return {
        success: false,
        message: "client_order_reference_id is required",
      };
    }

    const isCancelled = await Order.findOne({
      orderId: client_order_reference_id,
      status: "Cancelled",
    });

    if (isCancelled) {
      return {
        // success: false,
        code: 400,
        error: "Order is already cancelled",
      };
    }

    const accessToken = await getAccessToken();

    const requestPayload = {
      request_info: {
        ip_address: "14.142.227.166",
        browser_name: "Mozilla",
        location: "Delhi",
      },
      orders: {
        client_order_reference_ids: [client_order_reference_id],
        request_order_ids: [],
      },
    };

    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/orderCancellation",
      requestPayload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const cancellationDetails =
      response?.data?.data?.order_cancellation_details;

    if (cancellationDetails?.successful) {
      // await Order.updateOne(
      //   { orderId: client_order_reference_id },
      //   { $set: { status: "Cancelled" } }
      // );

      return {
        // error: true,
        code: 201,
        data: cancellationDetails.successful,
      };
    } else {
      console.error(
        "Smartship Cancellation Error:",
        cancellationDetails?.failure || "Unknown error"
      );
      return {
        code: 400,
        error: true,
        success: false,
        message: "Failed to cancel order",
        details: cancellationDetails?.failure || {},
      };
    }
  } catch (error) {
    console.error(
      "Smartship Cancel Order Error:",
      error?.response?.data || error.message
    );
    return {
      error: true,
      message: "Failed to cancel order",
      error: error?.response?.data || error.message,
    };
  }
};

// cancelSmartshipOrder(342276)

const trackOrderSmartShip = async (AWBNo, shipment_id) => {
  const access_key = await getAccessToken();
  // console.log(access_key);

  try {
    const response = await axios.post(
      `https://api.smartship.in/v1/Trackorder?tracking_numbers=${AWBNo}`,
      {}, // <-- empty body
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_key}`,
        },
      }
    );

    // console.log("response data", response.data);
    // console.log("respose status", response.data.data.scans);
    // console.log("response status", response.data.data.scans["20726635"][0].call_logs);
    if (response.data.message === "success") {
      const trackingData = response.data.data.scans;
      const request_order_id = Object.keys(trackingData || {})[0];
      const trackingArray = trackingData?.[request_order_id];
      return { success: true, data: trackingArray };
    }
  } catch (error) {
    console.error(
      "Error tracking shipment:",
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.response?.data || error.message,
      status: 500,
    };
  }
};

// trackOrderSmartShip("SMPC0000303506")

module.exports = {
  orderRegistrationOneStep,
  checkSmartshipHubServiceability,
  cancelSmartshipOrder,
  trackOrderSmartShip,
  registerSmartshipHub,
};
