if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const axios = require("axios");
const { fetchBulkWaybills, getDelhiveryApiKey } = require("../Authorize/saveCourierContoller");
const { getWaybill } = require("../Authorize/waybillPool");
const url = process.env.DELHIVERY_URL;
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const crypto = require("crypto");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const user = require("../../../models/User.model");
const plan = require("../../../models/Plan.model");
const CourierService = require("../../../models/CourierService.Schema");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const PickupAddress = require("../../../models/pickupAddress.model");
const createdDelhiveryWarehouses = new Set();
const warehousePromises = new Map();

// HELPER FUNCTIONS
const getCurrentDateTime = () => {
  const now = new Date();
  now.setSeconds(now.getSeconds() + 30);
  const pickup_date = now.toISOString().split("T")[0];
  const pickup_time = now.toTimeString().split(" ")[0];
  return { pickup_date, pickup_time };
};

// Helper function to generate a unique warehouse name for Delhivery
const getUniqueWarehouseName = (payload) => {
  const address = payload?.address || payload?.addressLine1 || "";
  const pinCode = payload?.pinCode || "";
  const phoneNumber = payload?.phoneNumber || payload?.contactNo || "";
  const contactName = payload?.contactName || "Default Warehouse";

  if (!address) return contactName;

  const addressKey = `${address}-${pinCode}-${phoneNumber}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const hash = crypto
    .createHash("md5")
    .update(addressKey)
    .digest("hex")
    .substring(0, 6);
  return `${contactName.substring(0, 30)}-${hash}`.trim();
};

const createClientWarehouse = async (payload, apiKey) => {
  if (!payload) {
    throw new Error("Payload is required to create a warehouse.");
  }

  const uniqueName = getUniqueWarehouseName(payload);

  // 1. Check in-memory success cache
  if (createdDelhiveryWarehouses.has(uniqueName)) {
    return {
      success: true,
      message: "Warehouse already exists (cached), proceeding",
      name: uniqueName,
    };
  }

  // 2. Check persistent MongoDB cache
  let addressDoc = null;
  try {
    addressDoc = await PickupAddress.findOne({
      "pickupAddress.pinCode": String(payload.pinCode),
      "pickupAddress.contactName": payload.contactName,
      "pickupAddress.address": payload.address,
    });
    if (addressDoc && addressDoc.delhiveryWarehouseName === uniqueName) {
      createdDelhiveryWarehouses.add(uniqueName);
      return {
        success: true,
        message: "Warehouse already exists (cached in DB), proceeding",
        name: uniqueName,
      };
    }
  } catch (err) {
    console.error("Delhivery warehouse lookup error from DB:", err.message);
    // Proceed to register via API if DB lookup fails
  }

  // 3. Concurrency Lock: Check if another parallel call is already registering this uniqueName
  if (warehousePromises.has(uniqueName)) {
    return warehousePromises.get(uniqueName);
  }

  const email = payload.email || payload.supportEmail || "";
  const phone = payload.phoneNumber || payload.contactNo || "";
  const address = payload.address || payload.addressLine1 || "";

  const warehouseDetails = {
    name: uniqueName,
    email: email,
    phone: phone,
    address: address,
    pin: payload.pinCode,
    city: payload.city,
    state: payload.state,
    return_address: address,
    return_pin: payload.pinCode,
    return_city: payload.city,
    return_state: payload.state,
    return_country: "India",
    country: "India",
  };

  const registerPromise = (async () => {
    try {
      const response = await axios.post(
        `${url}/api/backend/clientwarehouse/create/`,
        warehouseDetails,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Token ${apiKey || process.env.DEL_API_TOKEN}`,
          },
          timeout: 10000,
        },
      );

      if (response.data.success) {
        createdDelhiveryWarehouses.add(uniqueName);

        // Persist to MongoDB cache asynchronously
        if (addressDoc) {
          addressDoc.delhiveryWarehouseName = uniqueName;
          await addressDoc.save().catch((err) =>
            console.error("Failed to persist Delhivery warehouse name to DB:", err.message)
          );
        }

        return {
          success: true,
          message: "Warehouse created successfully",
          name: uniqueName,
          data: response.data,
        };
      } else {
        const errorMessage = response.data.error?.[0] || "";
        if (errorMessage.includes("already exists")) {
          createdDelhiveryWarehouses.add(uniqueName);

          if (addressDoc) {
            addressDoc.delhiveryWarehouseName = uniqueName;
            await addressDoc.save().catch((err) =>
              console.error("Failed to persist Delhivery warehouse name to DB:", err.message)
            );
          }

          return {
            success: true,
            message: "Warehouse already exists, proceeding",
            name: uniqueName,
            data: response.data.data,
          };
        } else {
          console.error(
            "Unknown error during warehouse creation:",
            response.data.error?.[0],
          );
          throw new Error(
            response.data.error?.[0] ||
            "Unknown error during warehouse creation.",
          );
        }
      }
    } catch (error) {
      const errorMessage = error.response?.data?.error?.[0] || "";

      if (errorMessage.includes("already exists")) {
        createdDelhiveryWarehouses.add(uniqueName);

        if (addressDoc) {
          addressDoc.delhiveryWarehouseName = uniqueName;
          await addressDoc.save().catch((err) =>
            console.error("Failed to persist Delhivery warehouse name to DB:", err.message)
          );
        }

        return {
          success: true,
          message: "Warehouse already exists, proceeding",
          name: uniqueName,
          data: error.response?.data?.data,
        };
      } else {
        console.error(
          "Error creating warehouse:",
          error.response?.data || error.message,
        );
        throw new Error(errorMessage || "Failed to create warehouse.");
      }
    }
  })();

  warehousePromises.set(uniqueName, registerPromise);

  try {
    const result = await registerPromise;
    return result;
  } finally {
    // Always clean up the promise registration when complete
    warehousePromises.delete(uniqueName);
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      id,
      provider,
      courierName,
      finalCharges,
      courierServiceName,
      estimatedDeliveryDate,
      priceBreakup
    } = req.body;

    session.startTransaction();

    // Step 1️⃣ Fetch order and lock
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

    // Step 2️⃣ Fetch user, wallet, and courier service concurrently
    const [users, plans, shipmentType] = await Promise.all([
      user.findById(currentOrder.userId).populate("Wallet").session(session),
      plan.findOne({ userId: currentOrder.userId }).session(session),
      CourierService.findOne({
        name: courierServiceName,
        provider: "Delhivery",
      }).session(session),
    ]);

    if (!users || !users.Wallet || !shipmentType) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: !users || !users.Wallet ? "User or Wallet not found" : "Invalid Courier Service Name",
      });
    }

    const currentWallet = users.Wallet;
    const internalCourierName = shipmentType.courierName || provider;

    // Fetch API key for the specific account
    const apiKey = await getDelhiveryApiKey(internalCourierName);

    // Step 3️⃣ Get waybills (from pool cache), zone & create warehouse in parallel
    const [waybills, zone, warehouseCreationResult] = await Promise.all([
      getWaybill(apiKey),
      getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode,
      ),
      createClientWarehouse(
        currentOrder.pickupAddress,
        apiKey,
      ),
    ]);

    if (!waybills || !waybills.length || !zone) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: (!waybills || !waybills.length)
          ? "No Waybill Available"
          : "Pincode not serviceable",
      });
    }

    if (!warehouseCreationResult || !warehouseCreationResult.success) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Failed to create or fetch pickup warehouse",
        details: warehouseCreationResult,
      });
    }

    // Step 5️⃣ Prepare payload (keep as-is)
    const pickupWarehouseName =
      warehouseCreationResult.name ||
      warehouseCreationResult.data?.name ||
      getUniqueWarehouseName(currentOrder.pickupAddress);

    const payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "Pre-paid";

    const payloadData = {
      pickup_location: { name: pickupWarehouseName },
      shipments: [
        {
          Waybill: waybills[0],
          country: "India",
          city: currentOrder.receiverAddress.city,
          pin: currentOrder.receiverAddress.pinCode,
          state: currentOrder.receiverAddress.state,
          order: currentOrder.orderId,
          add: currentOrder.receiverAddress.address || "Default Warehouse",
          payment_mode: payment_type,
          shipping_mode:
            shipmentType.courierType === "Domestic (Surface)"
              ? "Surface"
              : "Express",
          quantity: currentOrder.productDetails
            .reduce((sum, product) => sum + product.quantity, 0)
            .toString(),
          phone: currentOrder.receiverAddress.phoneNumber,
          products_desc: currentOrder.productDetails
            .map((p) => p.name)
            .join(", "),
          hsn_code: currentOrder.productDetails
            .map((product) => product.hsn)
            .join(", "),
          ewbn:
            currentOrder?.paymentDetails?.amount >= 50000
              ? currentOrder?.otherDetails?.ewaybill
              : "",
          total_amount: currentOrder.paymentDetails.amount,
          name: currentOrder.receiverAddress.contactName || "Default Warehouse",
          weight: currentOrder.packageDetails.applicableWeight * 1000,
          shipment_height: currentOrder.packageDetails.volumetricWeight.height,
          shipment_width: currentOrder.packageDetails.volumetricWeight.width,
          shipment_length: currentOrder.packageDetails.volumetricWeight.length,
          cod_amount:
            payment_type === "COD"
              ? `${currentOrder.paymentDetails.amount}`
              : "0",
        },
      ],
    };

    // console.log("payloadData", payloadData.shipments);

    const payload = `format=json&data=${encodeURIComponent(
      JSON.stringify(payloadData),
    )}`;

    // Step 6️⃣ Wallet check
    const walletHoldAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const balanceToBeDeducted =
      finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < balanceToBeDeducted) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // Step 7️⃣ Create Shipment (external API, keep as-is)
    const response = await axios.post(`${url}/api/cmu/create.json`, payload, {
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 8000,
    });
    // console.log("delhiver", response)
    const result = response.data?.packages?.[0];
    if (!response.data.success || !result) {
      await session.abortTransaction();
      session.endSession();
      console.log("error delhivery", response.data.packages[0].remarks)
      return res.status(400).json({
        success: false,
        message: "Failed to create shipment",
        details: response.data,
      });
    }

    // Step 8️⃣ Update order + wallet atomically
    await Promise.all([
      Order.findByIdAndUpdate(
        id,
        {
          $set: {
            status: "Booked",
            cancelledAtStage: null,
            awb_number: result.waybill,
            shipment_id: result.refnum,
            provider: provider,
            courierName: internalCourierName,
            totalFreightCharges: balanceToBeDeducted,
            courierServiceName,
            shipmentCreatedAt: new Date(),
            zone: zone.zone,
            estimatedDeliveryDate,
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
        { session },
      ),
      currentWallet.updateOne(
        {
          $inc: { balance: -balanceToBeDeducted },
        },
        { session },
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
      awb_number: result.waybill || "",
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

    // ✅ Final Response
    return res.status(201).json({
      success: true,
      message: "Shipment Created Successfully",
      orderId: currentOrder.orderId,
      provider,
      awb_number: result.waybill,
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error("Error in createOrder:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to create order.",
      error: error.message,
    });
  }
};

const checkPincodeServiceabilityDelhivery = async (
  pickUpPincode,
  deliveryPincode,
  order_type,
  courierName,
) => {
  const apiKey = await getDelhiveryApiKey(courierName); // Pass courierName to get the correct API key
  if (!pickUpPincode || !deliveryPincode) {
    return {
      success: false,
      message: "Pickup and Delivery Pincodes are required",
    };
  }
  // console.log(pickUpPincode,deliveryPincode)

  try {
    // --- Check Delivery Pincode ---
    const deliveryResponse = await axios.get(`${url}/c/api/pin-codes/json?`, {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
      params: { filter_codes: deliveryPincode },
      timeout: 8000,
    });
    // console.log("delivery service", deliveryResponse.data.delivery_codes);
    const deliveryCodes = deliveryResponse.data.delivery_codes || [];
    let deliveryServiceable = false;

    if (deliveryCodes.length > 0) {
      let { pre_paid, cash, pickup, remarks } = deliveryCodes[0].postal_code;
      deliveryServiceable =
        order_type === "Cash on Delivery"
          ? cash === "Y" && pickup === "Y" && remarks === ""
          : pre_paid === "Y" && pickup === "Y" && remarks === "";
    }

    // --- Check Pickup Pincode ---
    const pickupResponse = await axios.get(`${url}/c/api/pin-codes/json?`, {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
      params: { filter_codes: pickUpPincode },
      timeout: 5000,
    });
    // console.log("pickup servi", pickupResponse.data.delivery_codes);
    const pickupCodes = pickupResponse.data.delivery_codes || [];
    let pickupServiceable = false;

    if (pickupCodes.length > 0) {
      let { pre_paid, cash, pickup, remarks } = pickupCodes[0].postal_code;
      pickupServiceable =
        order_type === "Cash on Delivery"
          ? cash === "Y" && pickup === "Y" && remarks === ""
          : pre_paid === "Y" && pickup === "Y" && remarks === "";
    }

    // --- Final Result ---
    const finalResult = pickupServiceable && deliveryServiceable;
    return { success: finalResult, pickupServiceable, deliveryServiceable };
  } catch (error) {
    // console.error("Error fetching pincode serviceability:", error.message);
    return { success: false, error: error.message };
  }
};

const trackShipmentDelhivery = async (waybill) => {
  if (!waybill) {
    return {
      success: false,
      data: "Waybill number is required",
    };
  }

  try {
    const order = await Order.findOne({ awb_number: waybill });
    const apiKey = order ? await getDelhiveryApiKey(order.courierName || order.provider) : await getDelhiveryApiKey();

    const response = await axios.get(
      `${url}/api/v1/packages/json/?waybill=${waybill}`,
      {
        headers: {
          authorization: `Token ${apiKey}`,
        },
      },
    );

    const shipmentData = response?.data?.ShipmentData?.[0]?.Shipment;
    // console.log("shi",shipmentData)
    if (!shipmentData) {
      return {
        success: false,
        data: "No shipment data found",
      };
    }

    // Extract scans and remove the ScanDetail key
    const scans = shipmentData.Scans?.map((item) => item.ScanDetail) || [];
    // console.log("ship", scans);
    return {
      success: true,
      id: shipmentData.ReferenceNo,
      data: scans, // clean array without ScanDetail
    };
  } catch (error) {
    console.error("Error tracking shipment:", error.message);
    return {
      success: false,
      data: "Error in tracking",
    };
  }
};

// trackShipmentDelhivery("52710410025476")

const generateShippingLabel = async (req, res) => {
  const { waybill } = req.params;

  if (!waybill) {
    return res.status(400).json({ error: "Waybill number is required" });
  }

  try {
    const response = await axios.get(`${url}/api/p/packing_slip`, {
      params: {
        wbns: waybill,
        pdf: true,
      },
      responseType: "arraybuffer",
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="shipping-label-${waybill}.pdf"`,
    );

    return res.status(200).send(response.data);
  } catch (error) {
    console.error("Error generating shipping label:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to generate shipping label",
      error: error.message,
    });
  }
};

const createPickupRequest = async (warehouse_name, awb, pickupAddress = null, apiKey) => {
  const result = getCurrentDateTime();

  if (!apiKey) {
    const order = await Order.findOne({ awb_number: awb });
    apiKey = order ? await getDelhiveryApiKey(order.courierName || order.provider) : await getDelhiveryApiKey();
  }

  const finalWarehouseName = pickupAddress ? getUniqueWarehouseName(pickupAddress) : warehouse_name;

  const pickupDetails = {
    pickup_time: result.pickup_time,
    pickup_date: result.pickup_date,
    pickup_location: finalWarehouseName,
    expected_package_count: 1,
    waybill: `${awb}`,
  };

  if (
    !pickupDetails.pickup_time ||
    !pickupDetails.pickup_date ||
    !pickupDetails.pickup_location ||
    !pickupDetails.waybill
  ) {
    return { error: "All pickup details are required" };
  }

  try {
    const response = await axios.post(`${url}/fm/request/new/`, pickupDetails, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${apiKey}`,
      },
    });

    if (response?.data?.success) {
      return {
        success: true,
        message: "Pickup request created successfully",
        data: response.data,
        pickupDate: pickupDetails.pickup_date,
      };
    } else {
      return {
        success: false,
        message: "Failed to create pickup request",
      };
    }
  } catch (error) {
    return {
      success: false,
      message: "Failed to create pickup request",
      error: error.message,
    };
  }
};

// var createClientWarehouse = async (payload) => {
//  console.log("sdaaaaaaaaa",payload)
//   const warehouseDetails = {
//     name: payload.address,
//     phone: payload.phoneNumber,
//     address: payload.address,
//     pin: payload.pinCode,
//     city: payload.city,
//     state: payload.state,
//     // return_address: `${payload.addressLine1} ${payload.addressLine2}`,
//     // return_pin: payload.pinCode
//   }

//   if (!warehouseDetails) {
//     return res.status(400).json({ error: "Warehouse details are required" });
//   }

//   try {
//     const response = await axios.post(`${url}/api/backend/clientwarehouse/create/`, warehouseDetails, {
//       headers: {
//         'Content-Type': 'application/json',
//         Authorization: `Token ${API_TOKEN}`
//       },
//     });

//     return response.data;
//   } catch (error) {
//     console.error('Error:', error.response ? error.response.data : error.message);
//     throw error;
//   }
// };

const updateClientWarehouse = async (req, res) => {
  const { warehouseDetails } = req.body;

  if (!warehouseDetails) {
    return res.status(400).json({ error: "Warehouse details are required" });
  }

  try {
    const response = await axios.post(
      `${url}/api/backend/clientwarehouse/edit/`,
      warehouseDetails,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer YOUR_ACCESS_TOKEN",
        },
      },
    );

    return res.status(200).json({
      success: true,
      message: "Client warehouse updated successfully",
      data: response.data,
    });
  } catch (error) {
    console.error("Error updating client warehouse:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to update client warehouse",
      error: error.message,
    });
  }
};

const cancelOrderDelhivery = async (awb_number) => {
  // console.log("I am in cancel order");

  // Check if order is already cancelled
  const isCancelled = await Order.findOne({
    awb_number: awb_number,
    status: "Cancelled",
  });

  if (isCancelled) {
    console.log("Order is already cancelled");
    return {
      success: false,
      error: "Order is already cancelled",
      code: 400,
    };
  }
  const payload = {
    waybill: awb_number,
    cancellation: true,
    // isspace:true
  };

  try {
    const order = await Order.findOne({ awb_number: awb_number });
    const apiKey = order ? await getDelhiveryApiKey(order.courierName || order.provider) : await getDelhiveryApiKey();

    const response = await axios.post(`${url}/api/p/edit`, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${apiKey}`,
      },
    });
    console.log("cancel", response.data);

    if (response?.data?.status) {
      // await Order.updateOne(
      //   { awb_number: awb_number },
      //   { $set: { status: "Cancelled" } }
      // );
      return { data: response.data, code: 201 };
    } else {
      return {
        success: false,
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
      };
    }
  } catch (error) {
    console.error("Error in cancelOrderDelhivery:", error);
    return {
      success: false,
      error: "Internal Server Error",
      message: error.message,
      code: 500,
    };
  }
};
// cancelOrderDelhivery(35973710043864)

module.exports = {
  createOrder,
  checkPincodeServiceabilityDelhivery,
  trackShipmentDelhivery,
  generateShippingLabel,
  createPickupRequest,
  createClientWarehouse,
  updateClientWarehouse,
  cancelOrderDelhivery,
  getUniqueWarehouseName,
};
