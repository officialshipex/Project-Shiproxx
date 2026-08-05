const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");
const { getShipexToken } = require("../../AllCouriers/ShipxIndia/Authorize/shipxIndia.controller");
const CourierService = require("../../models/CourierService.Schema");
const estimatedDeliveryDate = require("../../models/EDDMap.model");

const createShipexIndiaShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  priceBreakup,
  userId,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // 1. Lock the order
    const currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true, session }
    );

    if (!currentOrder) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message: "Shipment already created or order is being processed.",
      };
    }

    // 2. Fetch User and Wallet
    const user = await User.findById(currentOrder.userId).session(session);
    if (!user) throw new Error("User not found");

    // 3. Balance Check
    const effectiveBalance = walletBalance - walletHoldAmount;
    const totalBalance = effectiveBalance + walletCreditLimit;
    if (totalBalance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      await Order.findByIdAndUpdate(id, { status: "new" });
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // 4. Get Zone
    const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      await Order.findByIdAndUpdate(id, { status: "new" });
      return { success: false, message: "Pincode not serviceable" };
    }

    // 5. Fetch estimated delivery date from DB
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "ShipexIndia",
      serviceName: courierServiceName.trim(),
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

    // 6. Authenticate with ShipexIndia
    const token = await getShipexToken();
    if (!token) throw new Error("ShipexIndia authentication failed");

    // 7. Map Order Details Payload for ShipexIndia
    const shipexPayload = {
      shipmentId: Number(currentOrder.orderId),
      pickupAddress: {
        contactName: currentOrder.pickupAddress.contactName,
        email: currentOrder.pickupAddress.email || user.email || "info@shiproxx.com",
        phoneNumber: String(currentOrder.pickupAddress.phoneNumber),
        address: currentOrder.pickupAddress.address,
        pinCode: String(currentOrder.pickupAddress.pinCode),
        city: currentOrder.pickupAddress.city,
        state: currentOrder.pickupAddress.state,
      },
      receiverAddress: {
        contactName: currentOrder.receiverAddress.contactName,
        email: currentOrder.receiverAddress.email || "info@shiproxx.com",
        phoneNumber: String(currentOrder.receiverAddress.phoneNumber),
        address: currentOrder.receiverAddress.address,
        pinCode: String(currentOrder.receiverAddress.pinCode),
        city: currentOrder.receiverAddress.city,
        state: currentOrder.receiverAddress.state,
      },
      productDetails: currentOrder.productDetails.map((item) => ({
        id: String(item.id),
        quantity: Number(item.quantity) || 1,
        name: item.name || "Product",
        sku: item.sku || String(item.id),
        unitPrice: String(item.unitPrice || 0),
      })),
      packageDetails: {
        deadWeight: Number(currentOrder.packageDetails?.deadWeight) || 0.5,
        applicableWeight: Number(currentOrder.packageDetails?.applicableWeight) || 0.5,
        volumetricWeight: {
          length: Number(currentOrder.packageDetails?.volumetricWeight?.length) || 10,
          width: Number(currentOrder.packageDetails?.volumetricWeight?.width) || 10,
          height: Number(currentOrder.packageDetails?.volumetricWeight?.height) || 10,
          calculatedWeight: Number(currentOrder.packageDetails?.volumetricWeight?.calculatedWeight) || 0.5,
        },
      },
      paymentDetails: {
        method: currentOrder.paymentDetails?.method === "COD" ? "COD" : "Prepaid",
        amount: Number(currentOrder.paymentDetails?.amount) || 0,
      },
    };

    console.log("ShipexIndia Create Order Payload:", JSON.stringify(shipexPayload, null, 2));

    // 8. Step 1: Create Order in ShipexIndia
    const createResponse = await axios.post(
      "https://api.shipexindia.com/v1/api/external/createOrder",
      shipexPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    console.log("ShipexIndia Create Order Response:", createResponse.data);

    if (!createResponse.data || !createResponse.data.success || !createResponse.data.data?.orderId) {
      throw new Error(createResponse.data?.message || "ShipexIndia order creation failed");
    }

    const shipexOrderId = createResponse.data.data.orderId;

    let shipexCourierName = courierServiceName;
    let shipexCourierId = "";

    try {
      const serviceDoc = await CourierService.findOne({ name: courierServiceName, provider: "ShipexIndia" });
      if (serviceDoc) {
        shipexCourierName = serviceDoc.courier || serviceDoc.name;
        shipexCourierId = serviceDoc.courier_id;
      }
    } catch (dbErr) {
      console.error("Error fetching CourierService details from DB:", dbErr.message);
    }

    if (!shipexCourierId) {
      const nameLower = String(shipexCourierName).toLowerCase();
      if (nameLower.includes("delhivery")) shipexCourierId = "02";
      else if (nameLower.includes("dtdc")) shipexCourierId = "03";
      else if (nameLower.includes("bluedart")) shipexCourierId = "13";
      else if (nameLower.includes("amazon")) shipexCourierId = "05";
      else if (nameLower.includes("maruti")) shipexCourierId = "06";
      else if (nameLower.includes("ekart")) shipexCourierId = "08";
      else if (nameLower.includes("xpressbees")) shipexCourierId = "09";
      else if (nameLower.includes("shadowfax")) shipexCourierId = "12";
      else shipexCourierId = "02";
    }

    // 9. Step 2: Book the order (Order Booking)
    const bookingPayload = {
      orderId: String(shipexOrderId),
      courierServiceName: shipexCourierName,
      courierId: shipexCourierId,
    };

    console.log("ShipexIndia Booking Payload:", bookingPayload);

    const bookingResponse = await axios.post(
      "https://api.shipexindia.com/v1/api/external/orderBooking",
      bookingPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 12000,
      }
    );

    console.log("ShipexIndia Booking Response:", bookingResponse.data);

    if (
      !bookingResponse.data ||
      bookingResponse.data.status !== "success" ||
      !bookingResponse.data.data?.awb_number
    ) {
      throw new Error(bookingResponse.data?.message || "ShipexIndia order booking failed");
    }

    const { awb_number, labelUrl } = bookingResponse.data.data;

    // 10. Update Order in DB
    const balanceToBeDeducted = parseFloat(finalCharges) || 0;

    currentOrder.status = "Booked";
    currentOrder.cancelledAtStage = null;
    currentOrder.awb_number = awb_number;
    currentOrder.label = labelUrl || "";
    const providerWord = shipexCourierName.split(" ")[0];
    currentOrder.provider = providerWord;
    currentOrder.partner = "ShipexIndia";
    currentOrder.shipment_id = String(shipexOrderId);
    currentOrder.totalFreightCharges = balanceToBeDeducted;
    currentOrder.courierServiceName = courierServiceName;
    currentOrder.zone = zone.zone;
    currentOrder.estimatedDeliveryDate = estimateDate || "";
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress.city,
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order booked successfully",
    });

    await currentOrder.save({ session });

    // 11. Update Wallet inside transaction
    await Promise.all([
      Wallet.updateOne(
        { _id: walletId },
        {
          $inc: { balance: -balanceToBeDeducted },
        },
        { session }
      ),
      WalletTransaction.create(
        [
          {
            walletId: walletId,
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: balanceToBeDeducted,
            balanceAfterTransaction: walletBalance - balanceToBeDeducted,
            awb_number: awb_number,
            description: "Freight Charges Applied",
            priceBreakup,
            date: new Date(),
          },
        ],
        { session }
      ),
    ]);

    await session.commitTransaction();
    session.endSession();

    // Auto-assign pickup manifest
    Order.findById(currentOrder._id)
      .then((freshOrder) => {
        if (freshOrder) assignPickupManifest(freshOrder);
      })
      .catch((pErr) => {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      });

    return {
      success: true,
      message: "Shipment Created Successfully",
      awb_number: awb_number,
      labelUrl: labelUrl || null,
    };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();

    await Order.updateOne(
      { _id: id, status: "processing" },
      { $set: { status: "new" } }
    );

    console.error("ShipexIndia Order Creation/Booking Error:", error.response?.data || error.message);
    return {
      success: false,
      message: error.response?.data?.message || error.message,
    };
  }
};

module.exports = createShipexIndiaShipment;
