const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const CourierService = require("../../../models/CourierService.Schema");
const { getZone } = require("../../../Rate/zoneManagementController");
const { bookJiffyShipment, extractJiffyErrorMessage, fetchJiffyLabelUrl } = require("./couriers.controller");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const createOrderJiffy = async (
  serviceDetails,
  orderId,
  wh,
  walletId,
  charges,
  priceBreakup
) => {
  // This is only ever called from newBulkOrders.controller.js's
  // callProviderWithRetry, which already atomically claims the order
  // (status: "new" -> "processing") once, up front, before trying each
  // eligible courier in turn. Do NOT re-claim or revert status here: if this
  // courier fails, the order must stay "processing" so the next courier in
  // the same fallback attempt can still be tried — a competing claim/revert
  // here previously made every courier after the first one in the list fail
  // with a false "already processing" error. The outer loop is solely
  // responsible for resetting status back to "new" once all couriers are
  // exhausted.
  const currentOrder = await Order.findById(orderId);
  if (!currentOrder) {
    return { success: false, message: "Order not found" };
  }

  try {
    console.log("➡️ Creating Jiffy shipment:", orderId);

    const [user, currentWallet, zone] = await Promise.all([
      User.findById(currentOrder.userId),
      Wallet.findById(walletId).select("balance holdAmount creditLimit"),
      getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode),
    ]);

    if (!user) {
      return { success: false, message: "User not found" };
    }
    if (!currentWallet) {
      return { success: false, message: "Wallet not found" };
    }

    const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0);
    const balance = effectiveBalance + (currentWallet.creditLimit || 0);
    if (balance < charges) {
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    if (!zone) {
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
      return { success: false, message: extractJiffyErrorMessage(err, "Failed to create shipment") };
    }

    const awb = shipmentData.awb_number;
    const finalCharges = parseFloat(charges) || 0;
    const providerWord = (shipmentData.courier_name || serviceDetails.name).split(" ")[0];

    // Amazon-fulfilled services booked through Jiffy are named with "ATS"
    // (Amazon's own carrier code) by convention — fetch Jiffy's real label
    // for those so the seller downloads Amazon's original label instead of
    // Shiproxx's generated one. Every other Jiffy courier is unaffected.
    let atsLabelUrl = null;
    if (/ats/i.test(serviceDetails?.name || "")) {
      atsLabelUrl = await fetchJiffyLabelUrl(awb);
    }

    currentOrder.status = "Booked";
    currentOrder.awb_number = awb;
    currentOrder.shipment_id = String(shipmentData.id || "");
    currentOrder.provider = providerWord;
    currentOrder.partner = "Jiffy";
    currentOrder.shipmentCreatedAt = new Date();
    currentOrder.totalFreightCharges = finalCharges;
    currentOrder.courierServiceName = serviceDetails.name;
    if (atsLabelUrl) currentOrder.label = atsLabelUrl;
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
      // failed to persist it. Do NOT revert status to "new" — Jiffy has
      // already committed a real shipment, so letting this order be retried
      // automatically would double-book it. Leave it "processing" and flag
      // loudly for manual reconciliation instead.
      console.error(
        `🚨 JIFFY ORPHANED SHIPMENT (bulk) — order ${orderId} booked at Jiffy with AWB ${awb} but failed to save. Manual reconciliation required.`,
        saveErr.message
      );
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
    return {
      success: false,
      message: extractJiffyErrorMessage(error, "Failed to create shipment"),
      error: error.response?.data || error.message,
    };
  }
};

module.exports = { createOrderJiffy };
