const axios = require("axios");
const { getAccessToken } = require("../Authorize/Ekart.controller"); // import your token function
const Order = require("../../../models/newOrder.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const pickupAddress = require("../../../models/pickupAddress.model");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

// =====================================================
// ⭐ SEPARATE GST CALCULATION FUNCTION
// =====================================================
function calculateGSTForItems(
  orderItems,
  sellerState,
  buyerState,
  sellerGSTIN,
) {
  const defaultGST = 18; // default GST if seller has no GSTIN
  const isInterState = sellerState !== buyerState;

  let totalTaxValue = 0;

  const updatedItems = orderItems.map((item) => {
    const price = (item.unitPrice || 0) * (item.quantity || 1);
    const gstRate = item.gstRate || defaultGST;

    const taxAmount = (price * gstRate) / 100;
    totalTaxValue += taxAmount;

    let cgst = 0,
      sgst = 0,
      igst = 0;

    if (isInterState) {
      igst = taxAmount;
    } else {
      cgst = taxAmount / 2;
      sgst = taxAmount / 2;
    }

    return {
      ...item,
      taxable_value: price,
      cgst_tax_value: cgst,
      sgst_tax_value: sgst,
      igst_tax_value: igst,
    };
  });

  return { updatedItems, totalTaxValue };
}

// =====================================================
// ⭐ MAIN FUNCTION
// =====================================================
const orderCreationEkart = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      id,
      finalCharges,
      courierServiceName,
      provider,
      estimatedDeliveryDate,
      priceBreakup
    } = req.body;
    // console.log("Received orderCreationEkart request:", req.body);

    const accessToken = await getAccessToken(courierServiceName);
    // console.log("Fetched Ekart access token:", accessToken);
    if (!accessToken) {
      return res.status(500).json({
        success: false,
        message: "Failed to get Ekart access token",
      });
    }

    session.startTransaction();

    // 1. Lock order
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
        message: "Order not in 'new' status.",
      });
    }

    // 2. Zone Check
    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode,
    );
    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Pincode not serviceable" });
    }

    // 3. Fetch Wallet
    const user = await User.findById(currentOrder.userId).session(session);
    const currentWallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);
    const holdAmount = currentWallet.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - holdAmount;

    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: "Insufficient Wallet Balance" });
    }

    // 4. Fetch pickup address FROM pickupAddress collection
    let pickup = await pickupAddress
      .findOne({
        "pickupAddress.contactName": currentOrder.pickupAddress.contactName,
        "pickupAddress.address": currentOrder.pickupAddress.address,
        "pickupAddress.pinCode": currentOrder.pickupAddress.pinCode,
      })
      .session(session);
    // console.log("Fetched pickup address:", pickup);
    if (!pickup) {
      const newAddress = new pickupAddress({
        userId: currentOrder.userId,
        pickupAddress: {
          contactName: currentOrder.pickupAddress.contactName,
          email: currentOrder.pickupAddress.email || "test@test.com",
          phoneNumber: currentOrder.pickupAddress.phoneNumber,
          address: currentOrder.pickupAddress.address,
          pinCode: currentOrder.pickupAddress.pinCode,
          city: currentOrder.pickupAddress.city,
          state: currentOrder.pickupAddress.state,
        },
      });
      pickup = await newAddress.save({ session });
    }

    let ekartAlias = pickup.ekartAlias;

    // 5. Register pickup address with Ekart (if alias missing)
    if (!ekartAlias) {
      // console.log("Registering pickup address with Ekart...");

      const addressPayload = {
        alias: `WAREHOUSE_${Date.now()}`,
        phone: pickup.pickupAddress.phoneNumber,
        address_line1: pickup.pickupAddress.address,
        address_line2: "",
        pincode: pickup.pickupAddress.pinCode,
        city: pickup.pickupAddress.city,
        state: pickup.pickupAddress.state,
        country: "IN",
        geo: { lat: 0, lon: 0 },
      };

      const addResult = await addEkartAddress(addressPayload, accessToken);
      // console.log("Ekart Add Address Result:", addResult);

      if (!addResult.success) {
        await session.abortTransaction();
        session.endSession();
        return res.status(500).json({
          success: false,
          message: "Failed to register pickup address with Ekart",
          error: addResult.error,
        });
      }

      ekartAlias = addResult.alias;

      await pickupAddress.updateOne(
        { _id: pickup._id },
        { $set: { ekartAlias } }
      );

      // console.log("Ekart alias saved:", ekartAlias);
    }

    // =====================================================
    // ⭐ 6. GST CALCULATION USING SEPARATE FUNCTION
    // =====================================================

    const sellerState = pickup.pickupAddress.state.trim();
    const buyerState = currentOrder.receiverAddress.state.trim();
    const sellerGSTIN = process.env.SELLER_GST_TIN || "";

    const { updatedItems, totalTaxValue } = calculateGSTForItems(
      currentOrder.productDetails,
      sellerState,
      buyerState,
      sellerGSTIN,
    );

    // =====================================================
    // ⭐ 7. BUILD EKART PAYLOAD
    // =====================================================

    const todayStr = new Date().toISOString().split("T")[0];
    const isCOD = currentOrder.paymentDetails.method === "COD";
    // console.log("Updated Items with GST:", updatedItems);

    const productsDesc = updatedItems.map((p) => p.name).join(", ") || "Goods";
    const cleanItems = updatedItems.map((i) => (i.toObject ? i.toObject() : i));

    const totalQuantity = cleanItems.reduce(
      (sum, p) => sum + (p._doc.quantity || 0),
      0,
    );
    // console.log("Clean Items for Ekart Payload:", cleanItems);
    const firstProduct = cleanItems[0] || {};

    const items = cleanItems.map((p) => ({
      product_name: p._doc.name,
      sku: p._doc.sku,
      taxable_value: p.taxable_value,
      cgst_tax_value: p.cgst_tax_value,
      sgst_tax_value: p.sgst_tax_value,
      igst_tax_value: p.igst_tax_value,
      quantity: p._doc.quantity,
      description: p._doc.name,
      length:
        p.length || currentOrder.packageDetails.volumetricWeight.length || 0,
      height:
        p.height || currentOrder.packageDetails.volumetricWeight.height || 0,
      breadth:
        p.width || currentOrder.packageDetails.volumetricWeight.width || 0,
      weight: p.weight || currentOrder.packageDetails.applicableWeight || 1,
      hsn_code: p._doc?.hsnCode || "",
    }));

    const payload = {
      seller_name: pickup.pickupAddress.contactName,
      seller_address: pickup.pickupAddress.address,
      seller_gst_tin: process.env.SELLER_GST_TIN || "",

      order_number: String(currentOrder.orderId),
      invoice_number: String(currentOrder.orderId),
      invoice_date: todayStr,
      consignee_gst_amount: totalTaxValue,
      consignee_name: currentOrder.receiverAddress.contactName,
      products_desc: productsDesc,
      payment_mode: isCOD ? "COD" : "Prepaid",

      total_amount: currentOrder.paymentDetails.amount,
      _taxable_amount: currentOrder.paymentDetails.amount,
      tax_value: totalTaxValue,
      taxable_amount: currentOrder.paymentDetails.amount,
      commodity_value: String(
        currentOrder.paymentDetails.amount - totalTaxValue,
      ),
      cod_amount: isCOD ? currentOrder.paymentDetails.amount : 0,

      quantity: totalQuantity,

      weight: currentOrder.packageDetails.applicableWeight,
      length: currentOrder.packageDetails.volumetricWeight.length,
      height: currentOrder.packageDetails.volumetricWeight.height,
      width: currentOrder.packageDetails.volumetricWeight.width,

      drop_location: {
        location_type: "Office",
        address: currentOrder.receiverAddress.address,
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
        country: "IN",
        name: currentOrder.receiverAddress.contactName,
        phone: Number(currentOrder.receiverAddress.phoneNumber),
        pin: Number(currentOrder.receiverAddress.pinCode),
      },

      pickup_location: { name: ekartAlias },
      return_location: { name: ekartAlias },

      items,
      what3words_address: "",
    };

    // =====================================================
    // ⭐ 8. EKART API CALL
    // =====================================================
    // console.log("Ekart Shipment Payload:", payload);
    let response;

    try {
      response = await axios.put(
        "https://app.elite.ekartlogistics.in/api/v1/package/create",
        payload,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000, // ✅ REQUIRED
        },
      );

      console.log("Ekart Shipment Response:", response.data);
    } catch (err) {
      console.log("Ekart Shipment Error:", err.response?.data || err.message);

      const ekartErr = err.response?.data;

      // ✅ If address not registered with Ekart → re-create address, update DB, retry
      if (
        err.response?.status === 404 &&
        ekartErr?.message === "SWIFT_RESOURCE_NOT_FOUND_EXCEPTION"
      ) {
        console.log(`[Ekart] Address not found on Ekart. Re-registering for pickup: ${pickup?._id}`);

        const newAddressPayload = {
          alias: `WAREHOUSE_${Date.now()}`,
          phone: pickup.pickupAddress.phoneNumber,
          address_line1: pickup.pickupAddress.address,
          address_line2: "",
          pincode: pickup.pickupAddress.pinCode,
          city: pickup.pickupAddress.city,
          state: pickup.pickupAddress.state,
          country: "IN",
          geo: { lat: 0, lon: 0 },
        };

        const reRegResult = await addEkartAddress(newAddressPayload, accessToken);

        if (reRegResult.success) {
          const newAlias = reRegResult.alias;
          console.log(`[Ekart] Re-registered address with alias: ${newAlias}`);

          // Update alias in DB
          await pickupAddress.updateOne(
            { _id: pickup._id },
            { $set: { ekartAlias: newAlias } }
          );

          // Update payload with new alias and retry
          payload.pickup_location = { name: newAlias };
          payload.return_location = { name: newAlias };

          try {
            response = await axios.put(
              "https://app.elite.ekartlogistics.in/api/v1/package/create",
              payload,
              {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 15000,
              },
            );
            console.log("[Ekart] Retry Shipment Response:", response.data);
          } catch (retryErr) {
            console.log("[Ekart] Retry Shipment Error:", retryErr.response?.data || retryErr.message);

            res.status(500).json({
              success: false,
              message:
                retryErr.code === "ECONNABORTED"
                  ? "Ekart timeout"
                  : retryErr.response?.data?.description || "Ekart Shipment Failed after address re-registration",
              error: retryErr.response?.data || retryErr.message,
            });

            process.nextTick(async () => {
              try {
                await session.abortTransaction();
                session.endSession();
              } catch (e) {
                console.error("Cleanup error:", e);
              }
            });

            return;
          }
        } else {
          console.log("[Ekart] Failed to re-register address:", reRegResult.error);

          res.status(500).json({
            success: false,
            message: "Ekart address not registered. Re-registration also failed.",
            error: reRegResult.error,
          });

          process.nextTick(async () => {
            try {
              await session.abortTransaction();
              session.endSession();
            } catch (e) {
              console.error("Cleanup error:", e);
            }
          });

          return;
        }
      } else {
        // ✅ Other errors → send response immediately
        res.status(500).json({
          success: false,
          message:
            err.code === "ECONNABORTED"
              ? "Ekart timeout"
              : err.response?.data?.description || "Ekart Shipment Failed",
          error: err.response?.data || err.message,
        });

        // ✅ CLEANUP ASYNC (do NOT block response)
        process.nextTick(async () => {
          try {
            await session.abortTransaction();
            session.endSession();
          } catch (e) {
            console.error("Cleanup error:", e);
          }
        });

        return;
      }
    }

    if (!response?.data?.status) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(400)
        .json({ success: false, message: response.data?.message });
    }

    // =====================================================
    // ⭐ 9. UPDATE ORDER AFTER SUCCESS
    // =====================================================

    const balanceToBeDeducted = parseFloat(finalCharges);

    await Order.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "Ready To Ship",
          awb_number: response.data.tracking_id,
          shipment_id: currentOrder.orderId,
          provider,
          courierServiceName,
          totalFreightCharges: balanceToBeDeducted,
          shipmentCreatedAt: new Date(),
          zone: zone.zone,
          estimatedDeliveryDate: estimatedDeliveryDate || null,
          priceBreakup
        },
        $push: {
          tracking: {
            status: "Ready To Ship",
            StatusLocation: currentOrder.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
            Instructions: "Order booked successfully",
          },
        },
      },
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    // ── Auto-assign pickup manifest ──
    try {
      const freshOrder = await Order.findById(id);
      if (freshOrder) {
        await assignPickupManifest(freshOrder);
      }
    } catch (pErr) {
      console.error("[Pickup] error:", pErr.message);
    }

    res.status(200).json({
      success: true,
      message: "Shipment Created Successfully",
      awb_number: response.data.tracking_id,
      orderId: currentOrder.orderId
    });

    // =====================================================
    // ⭐ 10. WALLET UPDATE ASYNC
    // =====================================================
    process.nextTick(async () => {
      try {
        const updatedWallet = await Wallet.findOneAndUpdate(
          { _id: user.Wallet },
          {
            $inc: { balance: -balanceToBeDeducted },
          },
          { new: true }
        );

        if (updatedWallet) {
          await WalletTransaction.create({
            walletId: updatedWallet._id,
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: balanceToBeDeducted,
            balanceAfterTransaction: updatedWallet.balance,
            date: new Date(),
            awb_number: response.data.tracking_id,
            description: "Freight Charges Applied",
            priceBreakup
          });
        }
      } catch (err) {
        console.error("Wallet update error:", err);
      }
    });
  } catch (err) {
    console.log("error ekart", err.response?.data || err.message)
    await session.abortTransaction();
    session.endSession();

    return res.status(500).json({
      success: false,
      message: "Failed to create shipment",
      error: err.message,
    });
  }
};

async function addEkartAddress(address, accessToken) {
  try {
    if (!accessToken) throw new Error("Failed to get Ekart access token");

    // -------------------------------------------------------
    // INLINE: CLEAN AND FIX address_line1
    // -------------------------------------------------------
    let line1 = (address.address_line1 || "").trim();
    
    // 1. Remove non-ASCII characters
    line1 = line1.replace(/[^\x20-\x7E]/g, "");

    // 2. Replace multiple spaces with a single space
    line1 = line1.replace(/\s+/g, " ");

    let line2 = (address.address_line2 || "").trim().replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ");

    // 3. If short → append city + state (Ekart requires min 10 chars, we enforce min 25 chars for safety)
    if (line1.length < 25) {
      line1 = `${line1} ${address.city} ${address.state}`.trim().replace(/\s+/g, " ");
    }

    // 4. If still short (rare), pad with dots instead of spaces (spaces at end can trigger validation issues)
    if (line1.length < 25) {
      line1 = line1.padEnd(25, ".");
    }
    // -------------------------------------------------------

    const payload = {
      alias: address.alias,
      phone: Number(address.phone),
      address_line1: line1,
      address_line2: line2,
      pincode: Number(address.pincode),
      city: address.city,
      state: address.state,
      country: address.country,
      geo: address.geo || { lat: 0, lon: 0 },
    };

    console.log("Ekart Address Payload:", payload);

    const response = await axios.post(
      "https://app.elite.ekartlogistics.in/api/v2/address",
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("Ekart Address Response:", response.data);

    return {
      success: true,
      alias: response.data?.alias,
      remark: response.data?.remark,
    };
  } catch (err) {
    console.error(
      "Ekart Add Address Error:",
      err.response?.data || err.message,
    );

    return {
      success: false,
      message: err.response?.data?.message || "Failed to add address",
      error: err.response?.data || err.message,
    };
  }
}

const cancelShipmentEkart = async (tracking_id) => {
  try {
    if (!tracking_id) {
      return {
        success: false,
        error: "tracking_id query parameter is required",
      };
    }

    const isCancelled = await Order.findOne({
      awb_number: tracking_id,
      status: "Cancelled",
    });
    if (isCancelled) {
      console.log("Order is already cancelled");
      return {
        error: "Order is already cancelled",
        code: 400,
      };
    }

    // 1. Find Order to get the correct account
    const order = await Order.findOne({ awb_number: tracking_id });
    const courierAccountName = order ? order.courierServiceName : null;

    // 2. Fetch valid access token for that account
    const accessToken = await getAccessToken(courierAccountName);
    if (!accessToken) {
      return { success: false, error: "Failed to get access token" };
    }

    // Call Ekart cancel shipment API
    const ekartCancelUrl = `https://app.elite.ekartlogistics.in/api/v1/package/cancel?tracking_id=${encodeURIComponent(
      tracking_id,
    )}`;

    const response = await axios.delete(ekartCancelUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    // Log response for debugging
    console.log("Ekart Cancel Shipment Response:", response.data);

    if (response.status === 200 && response.data.status === true) {
      // await Order.updateOne(
      //   { awb_number: tracking_id },
      //   { $set: { status: "Cancelled" } }
      // );

      return {
        data: response.data,
        code: 201,
      };
    } else {
      // If API response says cancellation failed

      return {
        success:false,
        error: "Error in shipment cancellation",
        details: response.data,
        code: 400,
      };
    }
  } catch (error) {
    console.error(
      "Error cancelling shipment with Ekart:",
      error.response?.data || error.message || error,
    );
    return {
      success: false,
      message: "Internal server error while cancelling shipment",
      error: error.response?.data.description || error.message,
    };
  }
};

const checkEkartServiceability = async (payload) => {
  try {
    const token = await getAccessToken(payload.courierName);
    if (!token) {
      return { success: false, message: "Failed to fetch access token" };
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const serviceabilityPayload = {
      pickupPincode: String(payload.pickUpPincode),
      dropPincode: String(payload.deliveryPincode),
      length: String(payload.length || "10"),
      height: String(payload.height || "10"),
      width: String(payload.width || "10"),
      weight: String(payload.weight || "0.5"),
      paymentType: payload.paymentMethod === "COD" ? "COD" : "Prepaid",
      serviceType: payload.serviceType || "SURFACE",
      codAmount: String(payload.codAmount || "0"),
      invoiceAmount: String(payload.codAmount || "0"),
    };

    // console.log("serviceability payload", serviceabilityPayload)

    const response = await axios.post(
      "https://app.elite.ekartlogistics.in/data/v3/serviceability",
      serviceabilityPayload,
      { headers }
    );
    // console.log("service", response.data);

    if (Array.isArray(response.data) && response.data.length > 0) {
      return {
        success: true,
        data: response.data[0],
      };
    } else if (response.data && response.data.status === true) {
      return {
        success: true,
        data: response.data.details || response.data,
      };
    } else {
      return {
        success: false,
        message:
          response.data?.message ||
          response.data?.description ||
          "Not serviceable",
        error: response.data,
      };
    }
  } catch (error) {
    console.error(
      "Ekart Serviceability Error:",
      error.response?.data || error.message,
    );

    return {
      success: false,
      error: error.response?.data || error.message,
    };
  }
};

const trackEkartShipment = async (id) => {
  if (!id) {
    throw new Error("Tracking ID is required");
  }

  try {
    // 1. Find Order to get the correct account
    const order = await Order.findOne({ awb_number: id });
    const courierAccountName = order ? order.courierServiceName : null;

    // 2. Fetch valid access token for that account
    const accessToken = await getAccessToken(courierAccountName);
    if (!accessToken) {
      throw new Error("Failed to get Ekart access token");
    }

    const url = `https://app.elite.ekartlogistics.in/api/v1/track/${id}`;

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    let trackingData = [];
    if (response.data) {
      if (response.data.track && Array.isArray(response.data.track.details)) {
        trackingData = response.data.track.details;
      } else if (Array.isArray(response.data.data)) {
        trackingData = response.data.data;
      } else if (response.data.track) {
        trackingData = [response.data.track];
      } else {
        trackingData = [response.data];
      }
    }

    return {
      success: true,
      data: trackingData,
    };
  } catch (error) {
    console.error("Ekart tracking error:", error.response?.data || error.message);
    return {
      success: false,
      message: error.response?.data?.message || "Failed to fetch Ekart tracking details",
      error: error.response?.data || error.message,
    };
  }
};

module.exports = {
  checkEkartServiceability,
  orderCreationEkart,
  cancelShipmentEkart,
  calculateGSTForItems,
  addEkartAddress,
  trackEkartShipment,
};


