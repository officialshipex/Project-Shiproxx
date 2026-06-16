const Order = require("../../../../../../models/newOrder.model");
const BASE_URL = process.env.B2B_SHIPROCKET_URL;
const { refreshToken } = require("../Authorize/shiprocket.controller");
const axios = require("axios");
const User = require("../../../../../../models/User.model");
const Wallet = require("../../../../../../models/wallet");
const WalletTransaction = require("../../../../../../models/WalletTransaction.model");
const mongoose = require("mongoose");

exports.createShiprocketCargoShipment = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      id,
      provider,
      courierServiceName,
      serviceId,
      modeId,
      finalCharges,
      rateBreakup,
    } = req.body;
    console.log("Creating Shiprocket Cargo Shipment for Order ID:", req.body);
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
      throw new Error("Shiprocket Cargo supports B2B only");

    /* ================================
       2️⃣ WALLET CHECK
    ================================= */
    const user = await User.findById(order.userId).session(session);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);

    const effectiveBalance = wallet.balance - (wallet.holdAmount || 0);
    const balance = effectiveBalance + wallet.creditLimit;

    if (balance < finalCharges) throw new Error("Insufficient Wallet Balance");
    const isAppointment = rateBreakup.appointment_charge > 0 ? true : false;
    /* ================================
       3️⃣ DEDUCT WALLET (IMMEDIATE)
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

    const orderCreationPayload = {
      no_of_packages: order.B2BPackageDetails.packages.reduce(
        (s, p) => s + p.noOfBox,
        0
      ),
      invoice_value: order.paymentDetails.amount,
      is_appointment_taken: isAppointment,
      approx_weight: order.B2BPackageDetails.applicableWeight,
      is_insured: false,
      is_to_pay: false,

      /* ===== PICKUP ===== */
      source_warehouse_name: order.pickupAddress.contactName,
      source_address_line1: order.pickupAddress.address,
      source_address_line2: "",
      source_pincode: order.pickupAddress.pinCode,
      source_city: order.pickupAddress.city,
      source_state: order.pickupAddress.state,

      sender_contact_person_name: order.pickupAddress.contactName,
      sender_contact_person_email:
        order.pickupAddress.email || "noreply@shiproxx.com",
      sender_contact_person_contact_no: order.pickupAddress.phoneNumber,

      /* ===== DELIVERY ===== */
      destination_warehouse_name: order.receiverAddress.contactName, // ✅ REQUIRED
      destination_address_line1: order.receiverAddress.address,
      destination_address_line2: "",
      destination_pincode: order.receiverAddress.pinCode,
      destination_city: order.receiverAddress.city,
      destination_state: order.receiverAddress.state,

      recipient_contact_person_name: order.receiverAddress.contactName,
      recipient_contact_person_email:
        order.receiverAddress.email || "noreply@shiproxx.com",
      recipient_contact_person_contact_no: order.receiverAddress.phoneNumber,

      /* ===== OTHER ===== */
      client_id: Number(process.env.SHIPROCKET_CARGO_CLIENT_ID),

      packaging_unit_details: order.B2BPackageDetails.packages.map((pkg) => ({
        units: pkg.noOfBox,
        weight: pkg.weightPerBox,
        length: pkg.length,
        width: pkg.width,
        height: pkg.height,
      })),

      is_cod: order.paymentDetails.method === "COD",
      cod_amount:
        order.paymentDetails.method === "COD"
          ? order.paymentDetails.amount
          : null,

      mode_name: "surface",
      source: "API",

      supporting_docs: [
        "https://shiproxx-india.s3.ap-south-1.amazonaws.com/invoices/6877cd814b130b3f25a64711/SHI-20251127-7800.pdf",
      ],
    };

    /* ================================
       4️⃣ SHIPROCKET API CALLS
    ================================= */
    const token = await refreshToken();

    // ---- order_creation ----
    const orderRes = await axios.post(
      `${BASE_URL}/api/external/order_creation/`,
      orderCreationPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Order Creation Response:", orderRes.data);

    const { order_id, mode_id, delivery_partner_id } = orderRes.data;
    const shipmentAssociationPayload = {
      client_id: Number(process.env.SHIPROCKET_CARGO_CLIENT_ID),
      order_id,
      remarks: "Shipment booked via API",

      // REQUIRED
      to_pay_amount: "0",
      modeId,
      serviceId,

      // REQUIRED FORMAT: "YYYY-MM-DD HH:mm:ss"
      pickup_date_time: new Date().toISOString().slice(0, 19).replace("T", " "),

      // GST / EWAY
      recipient_GST: order.otherDetails?.gstin || null,
      eway_bill_no: order.otherDetails?.ewaybill || "",

      // INVOICE
      invoice_value: order.paymentDetails.amount,
      invoice_number: `INV-${order.orderId}`.slice(0, 25),
      invoice_date: new Date().toISOString().split("T")[0],

      source: "API",

      // REQUIRED
      supporting_docs: [
        "https://shiproxx-india.s3.ap-south-1.amazonaws.com/invoices/6877cd814b130b3f25a64711/SHI-20251127-7800.pdf",
      ],
    };

    // ---- shipment_association ----
    const shipmentRes = await axios.post(
      `${BASE_URL}/api/order_shipment_association/`,
      shipmentAssociationPayload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("Shipment Association Response:", shipmentRes.data);

    /* ================================
       5️⃣ SAVE ORDER
    ================================= */
    await Order.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "Booked",
          provider: "shiprocket",
          courierServiceName,
          shipment_id: shipmentRes.data.id,
          shipmentCreatedAt: new Date(),
          totalFreightCharges: finalCharges,
          rateBreakup,
          walletDeducted: true,
        },
        $push: {
          tracking: {
            status: "Booked",
            Instructions: "Shipment booked, awaiting AWB",
            StatusDateTime: new Date(),
          },
        },
      },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    res.json({ success: true, shipment_id: shipmentRes.data.id });

    /* ================================
       6️⃣ ASYNC STATUS CHECK
    ================================= */
    setTimeout(
      () => getShiprocketCargoShipmentDetailsInternal(shipmentRes.data.id),
      60 * 1000
    );
  } catch (err) {
    console.log("Error in Shiprocket Cargo Shipment:", err.response.data);
    await session.abortTransaction();
    session.endSession();

    await Order.findByIdAndUpdate(req.body.id, { status: "new" });

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const getShiprocketCargoShipmentDetailsInternal = async (shipmentId) => {
  try {
    const order = await Order.findOne({ shipment_id: shipmentId });
    if (!order) return;

    const token = await refreshToken();

    const { data } = await axios.get(
      `${BASE_URL}/api/external/get_shipment/${shipmentId}/`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("Shiprocket Cargo Shipment Details:", data);
    const user = await User.findById(order.userId);
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");
    /* ================================
       ❌ SHIPMENT FAILED → REFUND
    ================================= */
    if (
      data.status === "Failed" &&
      order.walletDeducted &&
      !order.walletRefunded
    ) {
      const refundAmount = Number(order.totalFreightCharges);
      const newBalance = wallet.balance + refundAmount;
      const awbRef = data.waybill_no || order.awb_number || null;
      await Wallet.findByIdAndUpdate(user.Wallet, {
        $set: { balance: newBalance },
      });

      await WalletTransaction.create([{
        walletId: user.Wallet,
        category: "credit",
        channelOrderId: order.orderId,
        awb_number: awbRef,
        amount: refundAmount,
        balanceAfterTransaction: newBalance,
        description: "Freight Charges Received",
        date: new Date(),
      }]);

      await Order.findByIdAndUpdate(order._id, {
        walletRefunded: true,
        status: "Cancelled",
        $push: {
          tracking: {
            status: "Cancelled",
            Instructions: data.api_error || "Carrier rejected shipment",
            StatusDateTime: new Date(),
          },
        },
      });

      return;
    }

    /* ================================
       ⏳ STILL PROCESSING
    ================================= */
    if (!data.waybill_no) return;

    /* ================================
       ✅ SUCCESS → SAVE AWB + CHILD AWBs
    ================================= */
    await Order.findByIdAndUpdate(order._id, {
      $set: {
        awb_number: data.waybill_no,
        lrn: data.lrn,
        oid: data.order_id,
        label: data.label_url,
        partner: data.delivery_partner?.name,
        courierServiceName: data.delivery_partner?.common_name,
        status: "Ready To Ship",
      },
      $addToSet: {
        child_awb_numbers: {
          $each: data.child_waybill_nos || [],
        },
      },
      $push: {
        tracking: {
          status: "Ready To Ship",
          Instructions: "AWB generated successfully",
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
          awb_number: data.waybill_no
        }
      }
    ).catch(e => console.error("⚠️ WalletTransaction B2B ShipRocket AWB update failed:", e.message));
  } catch (err) {
    console.error("Shiprocket async error:", err.message);
  }
};

// getShiprocketCargoShipmentDetailsInternal("1398451");

const trackShiprocketCargoShipmentInternal = async (awb) => {
  try {
    if (!awb) {
      throw new Error("AWB number is required");
    }

    const token = await refreshToken();

    const { data } = await axios.get(`${BASE_URL}/api/shipment/track/${awb}/`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("🚚 Shiprocket Cargo Tracking Response:");
    console.log(data);

    return data; // optional, useful if you want to reuse
  } catch (error) {
    console.error(
      "❌ Shiprocket Cargo Tracking Error:",
      error?.response?.data || error.message
    );
    throw error;
  }
};

// trackShiprocketCargoShipmentInternal("20894534977234")

exports.getCargoServiceableCouriers = async ({ order, packages }) => {
  const accessToken = await refreshToken();
  if (!accessToken) {
    throw new Error("Shiprocket Cargo access token missing");
  }

  const payload = {
    from_pincode: order.pickupAddress.pinCode,
    from_city: order.pickupAddress.city,
    from_state: order.pickupAddress.state,

    to_pincode: order.receiverAddress.pinCode,
    to_city: order.receiverAddress.city,
    to_state: order.receiverAddress.state,

    quantity: packages.reduce((sum, p) => sum + Number(p.noOfBox || 0), 0),
    invoice_value: Number(order.paymentDetails?.amount || 0),
    calculator_page: "true",

    packaging_unit_details: packages.map((pkg) => ({
      units: Number(pkg.noOfBox),
      length: Number(pkg.length),
      width: Number(pkg.width),
      height: Number(pkg.height),
      weight: Number(pkg.weightPerBox),
      unit: "cm",
    })),
  };

  const response = await axios.post(
    `${BASE_URL}/api/shipment/charges/`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  const services = response.data || {};
  // console.log("Shiprocket Cargo Serviceability Response:", services);

  // ✅ Return service key + id
  return Object.keys(services)
    .filter((key) => key !== "success")
    .map((key) => ({
      key,
      id: services[key]?.id || null,
      modeId: services[key]?.mode_id || null,
    }));
};

const getCargoShipmentCharges = async () => {
  try {
    const accessToken = await refreshToken();
    if (!accessToken) {
      throw new Error("Shiprocket Cargo access token missing");
    }

    const payload = {
      from_pincode: "756036",
      from_city: "Bengaluru",
      from_state: "KARNATAKA",
      to_pincode: "756036",
      to_city: "Baliapal",
      to_state: "ODISHA",
      quantity: 4,
      invoice_value: 1111,
      calculator_page: "true",
      packaging_unit_details: [
        {
          units: 2,
          length: 20,
          height: 20,
          weight: 5,
          width: 20,
          unit: "cm",
        },
        {
          units: 2,
          length: 20,
          height: 20,
          weight: 5,
          width: 20,
          unit: "cm",
        },
      ],
    };

    const response = await axios.post(
      `${BASE_URL}/api/shipment/charges/`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    console.log("✅ Shiprocket Cargo Charges Response:");
    console.log(response.data);
  } catch (error) {
    console.error("❌ Shiprocket Cargo Charges Error:");
    // console.error(error?.response?.data || error.message);
  }
};

// getCargoShipmentCharges();
