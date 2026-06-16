const { refreshToken } = require("../Authorize/delhivery.controller");
const BASE_URL = process.env.DEL_URL;
const axios = require("axios");
const User = require("../../../../../../models/User.model");
const Wallet = require("../../../../../../models/wallet");
const WalletTransaction = require("../../../../../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const Order = require("../../../../../../models/newOrder.model");

const createDelhiveryB2BShipment = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { id, finalCharges, rateBreakup } = req.body;

    session.startTransaction();

    /* ================================
       1️⃣ LOCK ORDER
    ================================= */
    const order = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!order) throw new Error("Order already processed");
    if (order.orderType !== "B2B")
      throw new Error("Delhivery supports B2B only");

    /* ================================
       2️⃣ WALLET CHECK
    ================================= */
    const user = await User.findById(order.userId).session(session);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);

    const effectiveBalance = wallet.balance - (wallet.holdAmount || 0);
    const balance = effectiveBalance + wallet.creditLimit;

    if (balance < finalCharges) throw new Error("Insufficient Wallet Balance");

    /* ================================
       3️⃣ WALLET DEBIT
    ================================= */
    const newBalance = wallet.balance - Number(finalCharges);

    await Promise.all([
      Wallet.findByIdAndUpdate(
        user.Wallet,
        {
          $inc: { balance: -finalCharges },
        },
        { session }
      ),
      await WalletTransaction.create([
        {
          walletId: user.Wallet,
          channelOrderId: order.orderId,
          category: "debit",
          amount: finalCharges,
          balanceAfterTransaction: newBalance,
          description: "Freight Charges Applied",
          date: new Date(),
        }
      ], { session })
    ]);

    /* ================================
       4️⃣ MANIFEST PAYLOAD
    ================================= */
    const totalWeight = order.B2BPackageDetails.packages.reduce(
      (s, p) => s + p.noOfBox * p.weightPerBox,
      0
    );

    const form = new FormData();

    form.append("pickup_location_name", order.pickupAddress.contactName);
    form.append("payment_mode", order.paymentDetails.method.toLowerCase());
    form.append(
      "cod_amount",
      order.paymentDetails.method === "COD" ? order.paymentDetails.amount : 0
    );
    form.append("weight", totalWeight);
    form.append("rov_insurance", order.rovType === "carrier");

    /* 🔔 CALLBACK CONFIG */
    form.append(
      "callback",
      JSON.stringify({
        uri: `https://api.shiproxx.com/v1/webhook/delhivery/manifest`,
        method: "POST",
        authorization: `Bearer ${process.env.DELHIVERY_WEBHOOK_SECRET}`,
        headers: { "Content-Type": "application/json" },
      })
    );

    form.append(
      "dropoff_location",
      JSON.stringify({
        consignee_name: order.receiverAddress.contactName,
        address: order.receiverAddress.address,
        city: order.receiverAddress.city,
        state: order.receiverAddress.state,
        zip: order.receiverAddress.pinCode,
        phone: order.receiverAddress.phoneNumber,
        email: order.receiverAddress.email || "",
      })
    );

    form.append(
      "invoices",
      JSON.stringify([
        {
          ewaybill: order.otherDetails?.ewaybill || "",
          inv_num: `INV-${order.orderId}`,
          inv_amt: order.paymentDetails.amount,
          inv_qr_code: "",
        },
      ])
    );

    form.append(
      "shipment_details",
      JSON.stringify(
        order.B2BPackageDetails.packages.map((pkg, i) => ({
          order_id: `${order.orderId}-${i + 1}`,
          box_count: pkg.noOfBox,
          description: "B2B Cargo",
          weight: pkg.noOfBox * pkg.weightPerBox,
          waybills: [],
          master: false,
        }))
      )
    );

    form.append(
      "billing_address",
      JSON.stringify({
        name: order.pickupAddress.contactName,
        company: order.pickupAddress.contactName,
        consignor: order.pickupAddress.contactName,
        address: order.pickupAddress.address,
        city: order.pickupAddress.city,
        state: order.pickupAddress.state,
        pin: order.pickupAddress.pinCode,
        phone: order.pickupAddress.phoneNumber,
        gst_number: order.otherDetails?.gstin || "",
      })
    );

    /* ================================
       5️⃣ MANIFEST API CALL
    ================================= */
    const token = await refreshToken();

    const manifestRes = await axios.post(`${BASE_URL}/manifest`, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    });

    const jobId = manifestRes.data?.job_id;
    if (!jobId) throw new Error("Delhivery manifest failed");

    /* ================================
       6️⃣ SAVE ORDER
    ================================= */
    await Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          status: "Booked",
          provider: "Delhivery",
          manifestJobId: jobId,
          totalFreightCharges: finalCharges,
          rateBreakup,
          walletDeducted: true,
        },
        $push: {
          tracking: {
            status: "Booked",
            Instructions: "Delhivery manifest created",
            StatusDateTime: new Date(),
          },
        },
      },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    res.json({ success: true, job_id: jobId });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    await Order.findByIdAndUpdate(req.body.id, { status: "new" });

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const createDelhiveryPickupRequest = async (order) => {
  try {
    const token = await refreshToken();

    const packageCount =
      order.B2BPackageDetails?.packages?.reduce(
        (sum, pkg) => sum + Number(pkg.noOfBox || 0),
        0
      ) || 1;

    const response = await axios.post(
      `${BASE_URL}/pickup_requests`,
      {
        client_warehouse: order.pickupAddress?.contactName,
        pickup_date: new Date().toISOString().split("T")[0],
        start_time: "05:00:00",
        expected_package_count: packageCount,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    return {
      success: true,
      provider: "delhivery",
      orderId: order._id,
      data: response.data,
    };
  } catch (error) {
    return {
      success: false,
      provider: "delhivery",
      orderId: order._id,
      error: error?.response?.data || error.message,
    };
  }
};

const delhiveryManifestCallback = async (req, res) => {
  try {
    /* ================================
       🔐 AUTH VALIDATION
    ================================= */
    if (
      req.headers.authorization !==
      `Bearer ${process.env.DELHIVERY_WEBHOOK_SECRET}`
    ) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const payload = req.body;

    const order = await Order.findOne({
      manifestJobId: payload.job_id,
    });

    if (!order) return res.json({ success: true });

    const user = await User.findById(order.userId);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");

    /* ================================
       ❌ FAILED → REFUND
    ================================= */
    if (payload.status === "FAILED") {
      if (order.walletDeducted && !order.walletRefunded) {
        const refundAmount = order.totalFreightCharges;
        const newBalance = wallet.balance + refundAmount;

        await Wallet.findByIdAndUpdate(user.Wallet, {
          $set: { balance: newBalance },
        });

        await WalletTransaction.create([{
          walletId: user.Wallet,
          category: "credit",
          channelOrderId: order.orderId,
          amount: refundAmount,
          balanceAfterTransaction: newBalance,
          description: "Freight Charges Received",
          date: new Date(),
        }]);

        await Order.findByIdAndUpdate(order._id, {
          status: "Cancelled",
          walletRefunded: true,
          $push: {
            tracking: {
              status: "Cancelled",
              Instructions: payload.error || "Delhivery manifest failed",
              StatusDateTime: new Date(),
            },
          },
        });
      }

      return res.json({ success: true });
    }

    /* ================================
       ✅ SUCCESS → SAVE LR + AWBs
    ================================= */
    if (payload.status === "SUCCESS") {
      await Order.findByIdAndUpdate(order._id, {
        $set: {
          lrn: payload.lrn,
          awb_number: payload.awbs?.[0] || null,
          child_awb_numbers: payload.awbs || [],
          status: "Ready To Ship",
        },
        $push: {
          tracking: {
            status: "Ready To Ship",
            Instructions: "LR & AWB generated by Delhivery",
            StatusDateTime: new Date(),
          },
        },
      });

      await WalletTransaction.updateOne(
        {
          walletId: user.Wallet,
          channelOrderId: order.orderId,
          category: "debit"
        },
        {
          $set: {
            awb_number: payload.awbs?.[0] || null
          }
        }
      ).catch(e => console.error("⚠️ WalletTransaction B2B AWB update failed:", e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delhivery Callback Error:", err.message);
    res.json({ success: true });
  }
};

const checkDelhiveryServiceability = async ({ order, packages }) => {
  try {
    // 🔹 Delhivery Auth Token (use your real token logic)
    const accessToken = await refreshToken();
    if (!accessToken) {
      throw new Error("Delhivery access token missing");
    }

    const pickupPincode = order.pickupAddress.pinCode;
    const deliveryPincode = order.receiverAddress.pinCode;

    // 🔹 Calculate total dead weight (kg)
    const totalWeight = packages.reduce(
      (sum, p) => sum + Number(p.noOfBox || 0) * Number(p.weightPerBox || 0),
      0
    );

    // ===============================
    // PICKUP PINCODE CHECK
    // ===============================
    const pickupResponse = await axios.get(
      `https://ltl-clients-api-dev.delhivery.com/pincode-service/${pickupPincode}`,
      {
        params: { weight: totalWeight || 1 },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!pickupResponse.data || pickupResponse.data.serviceability !== true) {
      return false;
    }

    // ===============================
    // DELIVERY PINCODE CHECK
    // ===============================
    const deliveryResponse = await axios.get(
      `https://ltl-clients-api-dev.delhivery.com/pincode-service/${deliveryPincode}`,
      {
        params: { weight: totalWeight || 1 },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (
      !deliveryResponse.data ||
      deliveryResponse.data.serviceability !== true
    ) {
      return false;
    }

    // ✅ BOTH PINCODES SERVICEABLE
    return true;
  } catch (error) {
    console.error(
      "Delhivery Serviceability Error:",
      error.response?.data || error.message
    );
    return false;
  }
};

module.exports = {
  createDelhiveryB2BShipment,
  createDelhiveryPickupRequest,
  delhiveryManifestCallback,
  checkDelhiveryServiceability,
};
