const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const CourierService = require("../../../models/CourierService.Schema");
const { getZone } = require("../../../Rate/zoneManagementController");
const { bookJiffyShipment, extractJiffyErrorMessage } = require("./couriers.controller");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const revertOrderToNew = async (orderId) => {
  try {
    await Order.updateOne({ _id: orderId, status: "processing" }, { $set: { status: "new" } });
  } catch (revertErr) {
    console.error("[Jiffy bulk] Failed to revert order status after failure:", revertErr.message);
  }
};

const createOrderJiffy = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  charges,
  priceBreakup
) => {
  // Atomically lock the order — without this, two concurrent bulk-ship calls
  // for the same order could both pass and double-book/double-charge.
  const currentOrder = await Order.findOneAndUpdate(
    { _id: orderId, status: "new" },
    { $set: { status: "processing" } },
    { new: true }
  );
  if (!currentOrder) {
    return { success: false, message: "Shipment already created or order is being processed." };
  }

  try {
    console.log("➡️ Creating Jiffy shipment:", orderId);

    const [user, currentWallet, zone] = await Promise.all([
      User.findById(currentOrder.userId),
      Wallet.findById(walletId).select("balance holdAmount creditLimit"),
      getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode),
    ]);

    if (!user) {
      await revertOrderToNew(orderId);
      return { success: false, message: "User not found" };
    }
    if (!currentWallet) {
      await revertOrderToNew(orderId);
      return { success: false, message: "Wallet not found" };
    }

    const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + (currentWallet.creditLimit || 0);
    if (balance < charges) {
      await revertOrderToNew(orderId);
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    if (!zone) {
      await revertOrderToNew(orderId);
      return { success: false, message: "Pincode not serviceable" };
    }

    // The bulk-ship caller only passes {provider, name} in serviceDetails (no
    // courier code) — look up the manually-configured Jiffy courier_code
    // ourselves rather than always falling back to auto-assign.
    let courierCode = serviceDetails?.courier;
    if (!courierCode) {
      const serviceDoc = await CourierService.findOne({ name: serviceDetails.name, provider: "Jiffy" }).select("courier");
      courierCode = serviceDoc?.courier;
    }

    let shipmentData;
    try {
      shipmentData = await bookJiffyShipment(currentOrder, courierCode);
      console.log("Jiffy bulk create response:", shipmentData);
    } catch (err) {
      console.error("❌ Jiffy bulk create failed:", err.response?.data || err.message);
      await revertOrderToNew(orderId);
      return { success: false, message: extractJiffyErrorMessage(err, "Failed to create shipment") };
    }

    const awb = shipmentData.awb_number;
    const finalCharges = parseFloat(charges) || 0;
    const providerWord = (shipmentData.courier_name || serviceDetails.name).split(" ")[0];

    currentOrder.status = "Booked";
    currentOrder.awb_number = awb;
    currentOrder.shipment_id = String(shipmentData.id || "");
    currentOrder.provider = providerWord;
    currentOrder.partner = "Jiffy";
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.totalFreightCharges = finalCharges;
    currentOrder.courierServiceName = serviceDetails.name;
    currentOrder.zone = zone.zone;
    currentOrder.priceBreakup = priceBreakup;
    currentOrder.tracking.push({
      status: "Booked",
      StatusLocation: currentOrder.pickupAddress?.city || "N/A",
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Shipment booked successfully via Jiffy",
    });

    try {
      await currentOrder.save();
    } catch (saveErr) {
      // Jiffy already booked the shipment (we have its AWB) but Shiproxx
      // failed to persist it — nothing committed here, so it's safe to
      // revert and let this order be retried.
      console.error(
        `🚨 JIFFY ORPHANED SHIPMENT (bulk) — order ${orderId} booked at Jiffy with AWB ${awb} but failed to save. Manual reconciliation required.`,
        saveErr.message
      );
      await revertOrderToNew(orderId);
      return { success: false, message: `Shipment was booked with the courier (AWB ${awb}) but could not be saved — please contact support.` };
    }

    Order.findById(currentOrder._id)
      .then((freshOrder) => {
        if (freshOrder) assignPickupManifest(freshOrder);
      })
      .catch((pErr) => {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      });

    try {
      await Wallet.findOneAndUpdate({ _id: walletId }, { $inc: { balance: -finalCharges } });

      await WalletTransaction.create({
        walletId,
        channelOrderId: currentOrder.orderId || null,
        category: "debit",
        amount: finalCharges,
        balanceAfterTransaction: currentWallet.balance - finalCharges,
        date: new Date(),
        awb_number: awb,
        description: "Freight Charges Applied",
        priceBreakup,
      });
    } catch (walletErr) {
      // The order IS correctly booked (matches reality at Jiffy) — do NOT
      // revert it, or a later retry would create a duplicate shipment at
      // Jiffy. The wallet just wasn't charged; flag loudly for manual billing
      // reconciliation rather than losing this silently.
      console.error(
        `🚨 JIFFY WALLET DEBIT FAILED (bulk) — order ${orderId} booked (AWB ${awb}) but wallet was not charged ₹${finalCharges}. Manual reconciliation required.`,
        walletErr.message
      );
      return {
        success: true,
        message: "Shipment Created Successfully via Jiffy (wallet charge pending manual review)",
        data: { awb, shipmentId: shipmentData.id },
      };
    }

    return {
      success: true,
      message: "Shipment Created Successfully via Jiffy",
      data: { awb, shipmentId: shipmentData.id },
    };
  } catch (error) {
    console.error("❌ Jiffy bulk shipment error:", error.response?.data || error.message);
    await revertOrderToNew(orderId);
    return {
      success: false,
      message: extractJiffyErrorMessage(error, "Failed to create shipment"),
      error: error.response?.data || error.message,
    };
  }
};

module.exports = { createOrderJiffy };
