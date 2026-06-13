const axios = require("axios");
const { getAuthToken } = require("../Authorize/zipyPost.controller");
require("dotenv").config();
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const CourierService = require("../../../models/CourierService.Schema");
const PickupAddress = require("../../../models/pickupAddress.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const mongoose = require("mongoose");
const https = require("https");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const createWarehouse = async (
  userId,
  warehouseData,
  authToken,
  timestamp,
  sellerId
) => {
  try {
    // console.log("warehouse",warehouseData)
    const pickupAddress = await PickupAddress.findOne({
      userId,
      "pickupAddress.pinCode": warehouseData.pincode,
    });
    // console.log("pickup address",pickupAddress)
    if (!pickupAddress) {
      return {
        success: false,
      };
    }
    if (pickupAddress.zipypostHubId) {
      // console.log("✅ Smartship Hub already registered:", pickupAddress.smartshipHubId);
      return {
        success: true,
        warehouseId: pickupAddress.zipypostHubId,
      };
    }
    const response = await axios.post(
      "https://api.zipypost.com/create/warehouse",
      warehouseData,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: authToken,
          timestamp: timestamp,
          sellerId: sellerId,
        },
      }
    );

    if (response.data.success) {
      // console.log("warehouse", response.data);
      pickupAddress.zipypostHubId = response.data.warehouse_id;
      await pickupAddress.save();
      return {
        success: true,
        warehouseId: response.data.warehouse_id,
      };
    } else {
      console.error("Failed to create warehouse:", response.data.message);
      return null;
    }
  } catch (error) {
    console.error(
      "Error creating warehouse:",
      error.response?.data || error.message
    );
    return null;
  }
};

const httpsAgent = new https.Agent({ keepAlive: true });
axios.defaults.httpsAgent = httpsAgent;

// ✅ In-memory cache for Zipypost Auth Token
let zipyTokenCache = { token: null, expiry: 0 };
const getCachedAuthToken = async () => {
  if (zipyTokenCache.token && Date.now() < zipyTokenCache.expiry) {
    return { authToken: zipyTokenCache.token };
  }
  const token = await getAuthToken(); // Your existing function
  zipyTokenCache = {
    token: token.authToken,
    expiry: Date.now() + 45 * 60 * 1000, // 45 mins
  };
  return token;
};

// ✅ Cache for zone lookups to prevent repeated API hits
const zoneCache = new Map();
const getCachedZone = async (from, to) => {
  const key = `${from}-${to}`;
  if (zoneCache.has(key)) return zoneCache.get(key);
  const zone = await getZone(from, to);
  zoneCache.set(key, zone);
  return zone;
};

// ✅ Simple cache to avoid recreating warehouse for same pickup pincode
const warehouseCache = new Map();
const createZipypostOrder = async (req, res) => {
  const {
    id,
    provider,
    finalCharges,
    courierServiceName,
    courier,
    estimatedDeliveryDate,
    priceBreakup
  } = req.body;

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // ✅ Fetch order first
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

      // ✅ Fetch user first
      const user = await User.findById(currentOrder.userId).session(session);
      if (!user) throw new Error("User not found");

      // ✅ Get wallet using user.Wallet field
      if (!user.Wallet) throw new Error("User wallet not found");
      const currentWallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);
      if (!currentWallet) throw new Error("Wallet not found");

      // ✅ Check balance with safety margin
      const hold = currentWallet.holdAmount || 0;
      const effectiveBalance = currentWallet.balance - hold;
      const balance = effectiveBalance + currentWallet.creditLimit;
      if (balance < finalCharges) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Insufficient Wallet Balance",
        });
      }

      // ✅ Cached zone lookup (saves ~200–400ms)
      const zone = await getCachedZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      );
      if (!zone) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Pincode not serviceable",
        });
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const sellerId = process.env.ZIPYPOST_SELLER_ID;
      const token = await getAuthToken();

      // ✅ Serviceability check
      const payload = {
        source_pincode: currentOrder.pickupAddress.pinCode,
        destination_pincode: currentOrder.receiverAddress.pinCode,
        payment_type: currentOrder.paymentDetails?.method,
        order_weight: currentOrder.packageDetails.applicableWeight,
        length: currentOrder.packageDetails.volumetricWeight?.length || 0,
        breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
        height: currentOrder.packageDetails.volumetricWeight?.height || 0,
        order_value: currentOrder.paymentDetails?.amount || 0,
      };

      const serviceability = await checkZipypostServiceability(payload);
      if (!serviceability?.data?.length)
        throw new Error("No serviceable courier available");

      const validCouriers = serviceability.data.filter(
        (svc) => svc.courier_id === 9 || svc.courier_id === 10
      );

      let courier_id = 0;
      if (courierServiceName.toLowerCase().includes("xpressbees")) courier_id = 9;
      else if (courierServiceName.toLowerCase().includes("bluedart"))
        courier_id = 10;

      if (!courier_id) throw new Error("Only Xpressbees and Bluedart supported.");

      const courierOptions = validCouriers.filter(
        (svc) => svc.courier_id === courier_id
      );

      const applicableWeight = currentOrder.packageDetails.applicableWeight;
      const selectedMode =
        courierOptions.find(
          (option) => applicableWeight <= parseFloat(option.slab)
        ) || courierOptions[courierOptions.length - 1];

      if (!selectedMode) throw new Error("Unable to determine courier mode_id");

      const mode_id = selectedMode.mode_id;

      // ✅ Cached warehouse creation (reduces 700ms if already exists)
      const whKey = `${currentOrder.userId}-${currentOrder.pickupAddress.pinCode}`;
      let warehouseId = warehouseCache.get(whKey);

      if (!warehouseId) {
        const baseName = (
          currentOrder.pickupAddress.contactName || "Warehouse"
        ).substring(0, 10);
        const shortUserId = currentOrder.userId.toString().substring(0, 6);
        const finalWarehouseName =
          `${baseName}-${shortUserId}-${currentOrder.pickupAddress.pinCode}`.substring(
            0,
            30
          );

        const warehouseData = {
          warehouseName: finalWarehouseName,
          contactName: currentOrder.pickupAddress.contactName,
          contactNumber: currentOrder.pickupAddress.phoneNumber
            ? currentOrder.pickupAddress.phoneNumber.replace(/^0+/, "")
            : "",
          AddressLineOne:
            currentOrder.pickupAddress.address?.substring(0, 45) || "",
          AddressLineTwo:
            currentOrder.pickupAddress.address?.substring(0, 45) || "",
          pincode: currentOrder.pickupAddress.pinCode,
          city: currentOrder.pickupAddress.city,
          primary: true,
        };

        const whResult = await createWarehouse(
          currentOrder.userId,
          warehouseData,
          token.authToken,
          token.timestamp,
          sellerId
        );

        if (!whResult.success) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({
            success: false,
            message: "pickup address not registered first register pickup address",
          });
        }

        warehouseCache.set(whKey, whResult.warehouseId);
        warehouseId = whResult.warehouseId;
      }

      const totalProducts = currentOrder.productDetails.length;

      // ✅ Shipment creation payload
      const requestBody = {
        order_number: currentOrder.orderId,
        purchase_amount: currentOrder.paymentDetails.amount,
        purchase_date: currentOrder.createdAt.toISOString().split("T")[0],
        billing_details_same_as_shipping: true,
        shipping_details: {
          full_name: currentOrder.receiverAddress.contactName?.trim().slice(0, 30),
          contact_number: currentOrder.receiverAddress.phoneNumber
            ? currentOrder.receiverAddress.phoneNumber.replace(/^0+/, "")
            : "",
          customer_email:
            currentOrder.receiverAddress.email || "example@email.com",
          address_line_one:
            currentOrder.receiverAddress.address?.length > 104
              ? currentOrder.receiverAddress.address.slice(0, 104)
              : currentOrder.receiverAddress.address,

          address_line_two:
            currentOrder.receiverAddress.address?.length > 104
              ? currentOrder.receiverAddress.address.slice(0, 104)
              : currentOrder.receiverAddress.address,

          pincode: currentOrder.receiverAddress.pinCode,
          city: currentOrder.receiverAddress.city,
        },
        billing_details: {
          full_name: currentOrder.pickupAddress.contactName,
          contact_number: currentOrder.pickupAddress.phoneNumber
            ? currentOrder.pickupAddress.phoneNumber.replace(/^0+/, "")
            : "",

          address_line_one:
            currentOrder.pickupAddress.address?.substring(0, 45) || "",
          address_line_two:
            currentOrder.pickupAddress.address?.substring(45, 90) || "",
          pincode: currentOrder.pickupAddress.pinCode,
          city: currentOrder.pickupAddress.city,
        },
        items: currentOrder.productDetails.map((p) => ({
          sku: p.sku?.length >= 3 ? p.sku : `SKU${currentOrder.orderId}`,
          item_name: p.name,
          quantity: p.quantity || 1,
          item_weight:
            currentOrder.packageDetails.applicableWeight / totalProducts,
          item_price: p.unitPrice,
        })),
        package_length: currentOrder.packageDetails.length || 10,
        package_width: currentOrder.packageDetails.width || 10,
        package_height: currentOrder.packageDetails.height || 10,
        package_weight: currentOrder.packageDetails.applicableWeight || 0.5,
        warehouse_id: warehouseId,
        payment_type: currentOrder.paymentDetails.method === "COD" ? 2 : 1,
        courier_id,
        mode_id,
      };

      console.log("request body", requestBody);

      // ✅ Call Zipypost API
      const response = await axios.post(
        "https://api.zipypost.com/create/shipment",
        requestBody,
        {
          headers: {
            "Content-Type": "application/json",
            authorization: token.authToken,
            timestamp: token.timestamp,
            sellerid: sellerId,
          },
        }
      );
      console.log("Zipypost Shipment Response:", response.data);

      if (!response.data.success || !response.data.booking) {
        throw new Error(response.data.message || "Failed to create shipment");
      }

      const result = response.data.RESULT;

      // ✅ Update order + wallet atomically
      currentOrder.status = "Booked";
      currentOrder.awb_number = result.awb;
      currentOrder.shipment_id = currentOrder.orderId;
      currentOrder.provider = result.courier.replace(/\+/g, "").trim();
      currentOrder.partner = "ZipyPost";
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.totalFreightCharges = parseFloat(finalCharges) || 0;
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.zone = zone.zone;
      currentOrder.estimatedDeliveryDate = estimatedDeliveryDate || "";
      currentOrder.priceBreakup = priceBreakup;
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress.city,
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        Instructions: "Order booked successfully",
      });

      currentWallet.balance -= finalCharges;
      await WalletTransaction.create([{
        walletId: currentWallet._id,
        channelOrderId: currentOrder.orderId,
        category: "debit",
        amount: finalCharges,
        balanceAfterTransaction: currentWallet.balance,
        awb_number: result.awb,
        description: "Freight Charges Applied",
        priceBreakup
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

      // ✅ Fast success response
      return res.status(200).json({
        success: true,
        message: "Shipment Created Successfully",
        awb_number: result.awb,
        orderId: currentOrder.orderId
      });
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();

      // Check if transient error (Write Conflict)
      const isTransient =
        error.errorLabels?.includes("TransientTransactionError") ||
        error.code === 112 ||
        error.message?.includes("WriteConflict");

      if (isTransient && attempt < maxRetries) {
        console.warn(`[Zipypost createOrder] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }

      console.error(
        "Error creating Zipypost shipment:",
        error?.response?.data || error.message
      );
      return res.status(500).json({
        success: false,
        message:
          error?.response?.data?.error?.booking_process_error ||
          error.message ||
          "Failed to create shipment",
      });
    }
  }
};

const checkZipypostServiceability = async (payload) => {
  try {
    const requestBody = {
      pickup_pincode: payload.source_pincode,
      drop_pincode: payload.destination_pincode,
      payment_type: payload.payment_type === "COD" ? 2 : 1, // 1 = Prepaid, 2 = COD (example)
      purchase_amount: payload.order_value || 100,
      length: payload.length || 5,
      width: payload.width || 5,
      height: payload.height || 5,
      weight: payload.order_weight || 0.5,
    };
    // const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();
    // console.log("token", token);
    const response = await axios.post(
      "https://api.zipypost.com/getservicepricing",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          authorization: token.authToken,
          timestamp: token.timestamp,
          sellerid: sellerId,
        },
      }
    );
    // console.log("Zipypost Serviceability Response:", response.data);
    const serviceabilityData = response.data?.result || [];
    const serviceable =
      response.data?.success === true && serviceabilityData.length > 0;

    return {
      success: serviceable,
      data: serviceabilityData,
    };
  } catch (err) {
    console.log("error", err.response.data.error);
    return {
      success: false,
      error: err.response?.data || err.message,
    };
  }
};

const cancelOrderZipypost = async (AWBNo) => {
  try {
    // Validate inputs
    if (!AWBNo) {
      return {
        success: false,
        message: "awb_number is required",
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

    // console.log("Cancel Order Request Data:", requestData);
    const timestamp = Math.floor(Date.now() / 1000);
    const sellerId = process.env.ZIPYPOST_SELLER_ID;
    const token = await getAuthToken();
    // API Call with Proper Authorization Header
    const response = await axios.get(
      `https://api.zipypost.com/cancel/shipment/${AWBNo}`,
      {
        headers: {
          authorization: token.authToken,
          timestamp: token.timestamp,
          sellerid: sellerId,
        },
      }
    );

    console.log("zipypost Cancel Response:", response.data);
    if (response?.data?.success) {
      // await Order.updateOne(
      //   { awb_number: AWBNo },
      //   { $set: { status: "Cancelled" } }
      // );
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
// cancelOrderZipypost('152489850354007')

const trackOrderZipypost = async (AWBNo) => {
  const token = await getAuthToken();
  // const timestamp = Math.floor(Date.now() / 1000);
  const sellerId = process.env.ZIPYPOST_SELLER_ID;
  // console.log(access_key);

  try {
    const response = await axios.get(
      `https://api.zipypost.com/track/${AWBNo}`,
      {
        headers: {
          authorization: token.authToken,
          timestamp: token.timestamp,
          sellerid: sellerId,
        },
      }
    );

    // console.log("response data", response.data);
    // console.log("respose status", response.data.result.events);
    // console.log("response status", response.data.data.scans["20726635"][0].call_logs);
    if (response.data.success === true) {
      return { success: true, data: response.data.result.events };
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
// trackOrderZipypost("77699762184")

module.exports = {
  createWarehouse,
  createZipypostOrder,
  checkZipypostServiceability,
  cancelOrderZipypost,
  trackOrderZipypost,
  getCachedZone
};
