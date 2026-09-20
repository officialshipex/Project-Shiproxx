const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const { getZone } = require("../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");
const { getAuthToken } = require("../../AllCouriers/ShipRocket/Authorize/shiprocket.controller");
const { findShiprocketService } = require("../../utils/shiprocketServiceLookup");
const { fitShiprocketAddress } = require("../../utils/shiprocketAddress");
const { getPickupLocations, invalidatePickupLocations, isPickupLocationError } = require("../../utils/shiprocketPickupCache");

const BASE_URL = `${process.env.SHIPROCKET_URL}/v1/external`;
const SHIPROCKET_EMAIL = process.env.SHIPR_GMAIL;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getCurrentDateTime = () => {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${date} ${hours}:${minutes}`;
};

const generateSKU = (name) => {
  const clean = (name || "PROD").replace(/[^a-zA-Z0-9]/g, "").substring(0, 5).toUpperCase();
  return `${clean}${Math.floor(1000 + Math.random() * 9000)}`;
};

const cleanPhone = (phone) => {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const splitName = (fullName) => {
  const parts = (fullName || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "." };
};

const ensureAddress = (addr) => {
  let clean = (addr || "").trim();
  if (clean.length < 10) {
    clean = clean + " House No 1, Main Road";
  }
  return clean;
};

// Hand an order we claimed ("processing") back as "new" after a failed booking.
// This used to happen implicitly: the claim ran inside a transaction that was
// aborted on every failure.
const revertOrderToNew = async (id) => {
  try {
    await Order.updateOne({ _id: id, status: "processing" }, { $set: { status: "new" } });
  } catch (revertErr) {
    console.error("[Shiprocket] Failed to revert order status after failure:", revertErr.message);
  }
};

// Shiprocket's own reason for refusing an AWB (e.g. courier does not serve
// this pincode pair) — reported to the caller instead of a bare "failed".
const describeAwbFailure = (body) =>
  String(
    body?.response?.data?.awb_assign_error || body?.message || body?.response?.data?.message || (body ? JSON.stringify(body) : "no response from Shiprocket")
  ).slice(0, 300);

// Fetches Shiprocket's own generated label PDF for a shipment. Only called
// for services whose name marks them as Amazon-fulfilled ("ATS" — Amazon's
// own carrier code), so the seller downloads Amazon's original label
// instead of Shiproxx's generated one. Every other Shiprocket courier is
// unaffected and keeps using the generated label as before.
const fetchShiprocketLabelUrl = async (shipment_id) => {
  try {
    const token = await getAuthToken();
    if (!token) return null;
    const response = await axios.get(`${BASE_URL}/courier/generate/label`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { shipment_id },
      timeout: 15000,
    });
    return response.data?.label_url || null;
  } catch (error) {
    console.error("Shiprocket ATS label fetch failed:", error.response?.data || error.message);
    return null;
  }
};

const createShiprocketShipment = async ({
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
  // Step 1️⃣ Atomically claim the order. A single findOneAndUpdate is already
  // atomic on its own — no transaction is needed for this. (The transaction
  // used to be opened here and stay open across every Shiprocket call below,
  // holding the order and a snapshot of the wallet for seconds.)
  let currentOrder;
  try {
    currentOrder = await Order.findOneAndUpdate(
      { _id: id, status: "new" },
      { $set: { status: "processing" } },
      { new: true }
    );
  } catch (error) {
    // Callers expect a { success: false } result, not a thrown error (the
    // claim used to sit inside the try/catch below).
    console.error("Shiprocket Creation Error:", error.message);
    return { success: false, message: error.message, error: error.message };
  }

  if (!currentOrder) {
    return { success: false, message: "Shipment already created or order not in 'new' status." };
  }

  // From here on, every way out except success hands the order back as "new".
  const fail = async (result) => {
    await revertOrderToNew(id);
    return result;
  };

  // Set once Shiprocket has issued an AWB, so a failure to save it is reported
  // against the AWB instead of vanishing.
  let bookedAwb = null;

  try {
    // Step 2️⃣ Wallet check
    if (!walletId) {
      return await fail({ success: false, message: "Wallet not found" });
    }

    // Step 3️⃣ Wallet Balance Check
    const effectiveBalance = walletBalance - (walletHoldAmount || 0);
    const balanceToBeDeducted = parseFloat(finalCharges) || 0;
    const totalBalance = effectiveBalance + (walletCreditLimit || 0);

    if (totalBalance < balanceToBeDeducted) {
      return await fail({ success: false, message: "Insufficient Wallet Balance" });
    }

    // Step 4️⃣ Get Zone
    const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
    if (!zone) {
      return await fail({ success: false, message: "Pincode not serviceable" });
    }

    // Step 5️⃣ Fetch EDD (Estimated Delivery Date)
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Shiprocket",
      serviceName: courierServiceName.trim(),
    });

    let estimateDate = null;
    if (eddData) {
      const deliveryDays = eddData.zoneRates?.[zone.zone] || eddData[zone.zone];
      if (typeof deliveryDays === "number") {
        estimateDate = new Date();
        estimateDate.setDate(estimateDate.getDate() + deliveryDays);
      }
    }

    // Step 6️⃣ Authenticate with Shiprocket
    const token = await getAuthToken();
    if (!token) {
      return await fail({ success: false, message: "ShipRocket authentication failed" });
    }

    // Resolve the courier_id for the requested service BEFORE creating
    // anything on Shiprocket. Names come from rate cards / the UI and drift
    // from CourierService.name in case and spacing, so match ignoring both.
    // This path used to fall back to a courier-less "auto-assign" call when
    // the lookup missed, letting Shiprocket pick an arbitrary courier while
    // we still recorded and billed the requested one — refuse instead.
    const courierService = await findShiprocketService(courierServiceName);
    if (!courierService?.courier_id) {
      return await fail({
        success: false,
        message: `No Shiprocket courier ID is configured for service "${courierServiceName}" — not booking, because Shiprocket would auto-assign an arbitrary courier instead of the one being charged for.`,
      });
    }

    // Step 7️⃣ Add/Verify Pickup Location in Shiprocket
    let pickupLocationName = currentOrder.pickupAddress.contactName;
    try {
      // Existing pickup locations (kept for a while — see shiprocketPickupCache —
      // instead of being re-fetched for every single booking)
      const existingLocations = await getPickupLocations(token);
      console.log("Existing Shiprocket Locations Count:", existingLocations.length);

      // Try to find a match by pincode and address snippet to be more accurate
      const orderPin = String(currentOrder.pickupAddress.pinCode);
      const orderAddr = (currentOrder.pickupAddress.address || "").toLowerCase();

      const match = existingLocations.find(loc => {
        const locPin = String(loc.pin_code);
        const locAddr = (loc.address || "").toLowerCase();
        return locPin === orderPin && (orderAddr.includes(locAddr.substring(0, 10)) || locAddr.includes(orderAddr.substring(0, 10)));
      }) || existingLocations.find(loc => String(loc.pin_code) === orderPin);

      if (match) {
        pickupLocationName = match.pickup_location;
        console.log("Matched existing location nickname:", pickupLocationName);
      } else {
        console.log("No matching location found for pincode:", orderPin, ". Attempting to add new location with name:", pickupLocationName);
        // If no match, try to add new one
        try {
          await axios.post(
            `${BASE_URL}/settings/company/addpickup`,
            {
              pickup_location: pickupLocationName,
              name: currentOrder.pickupAddress.contactName,
              email: currentOrder.pickupAddress.email || SHIPROCKET_EMAIL,
              phone: cleanPhone(currentOrder.pickupAddress.phoneNumber),
              address: ensureAddress(currentOrder.pickupAddress.address),
              city: currentOrder.pickupAddress.city,
              state: currentOrder.pickupAddress.state,
              country: "India",
              pin_code: orderPin,
            },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
          );
        } finally {
          // Whether it was added or already existed, our remembered list is stale.
          invalidatePickupLocations();
        }
      }
    } catch (e) {
      console.error("Shiprocket Pickup Location Sync Error:", e.response?.data || e.message);
      // If adding fails for validation (like address length), we must stop and inform the user
      if (e.response?.status !== 422) {
        let errMsg = "Shiprocket Pickup Location Error";
        if (e.response?.data?.message) {
          try {
            const parsed = JSON.parse(e.response.data.message);
            if (parsed.address) errMsg += ": " + parsed.address.join(" ");
          } catch (err) {
            errMsg += ": " + e.response.data.message;
          }
        }
        return await fail({ success: false, message: errMsg });
      }
    }

    // Step 8️⃣ Prepare Shiprocket Payload
    const senderName = splitName(currentOrder.pickupAddress.contactName);
    const receiverName = splitName(currentOrder.receiverAddress.contactName);
    const isCOD = currentOrder.paymentDetails.method === "COD";

    // Shiprocket rejects the order if address_1 + address_2 exceed 190 chars.
    const billingAddress = fitShiprocketAddress(ensureAddress(currentOrder.pickupAddress.address), currentOrder.pickupAddress);
    const shippingAddress = fitShiprocketAddress(ensureAddress(currentOrder.receiverAddress.address), currentOrder.receiverAddress);

    const shiprocketPayload = {
      order_id: String(currentOrder.orderId),
      order_date: getCurrentDateTime(),
      pickup_location: pickupLocationName,
      billing_customer_name: senderName.first,
      billing_last_name: senderName.last,
      billing_address: billingAddress,
      billing_city: currentOrder.pickupAddress.city,
      billing_pincode: String(currentOrder.pickupAddress.pinCode),
      billing_state: currentOrder.pickupAddress.state,
      billing_country: "India",
      billing_email: currentOrder.pickupAddress.email || SHIPROCKET_EMAIL,
      billing_phone: cleanPhone(currentOrder.pickupAddress.phoneNumber),
      shipping_is_billing: false,
      shipping_customer_name: receiverName.first,
      shipping_last_name: receiverName.last,
      shipping_address: shippingAddress,
      shipping_city: currentOrder.receiverAddress.city,
      shipping_pincode: String(currentOrder.receiverAddress.pinCode),
      shipping_state: currentOrder.receiverAddress.state,
      shipping_country: "India",
      shipping_email: currentOrder.receiverAddress.email || SHIPROCKET_EMAIL,
      shipping_phone: cleanPhone(currentOrder.receiverAddress.phoneNumber),
      order_items: currentOrder.productDetails.map((p) => ({
        name: p.name || "Product",
        sku: p.sku || generateSKU(p.name),
        units: Number(p.quantity) || 1,
        selling_price: parseFloat(p.unitPrice) || 0,
      })),
      payment_method: isCOD ? "COD" : "Prepaid",
      sub_total: currentOrder.paymentDetails.amount,
      length: currentOrder.packageDetails.volumetricWeight?.length || 10,
      breadth: currentOrder.packageDetails.volumetricWeight?.width || 10,
      height: currentOrder.packageDetails.volumetricWeight?.height || 10,
      weight: currentOrder.packageDetails.applicableWeight || 0.5,
    };

    // Step 9️⃣ Create Order in Shiprocket — called exactly once. It is
    // deliberately outside any retry loop: retrying a transient database
    // conflict must never re-create the order (and assign a second AWB) at
    // Shiprocket.
    const orderResponse = await axios.post(`${BASE_URL}/orders/create/adhoc`, shiprocketPayload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });

    console.log("response data", orderResponse.data, orderResponse.data.data)

    if (!orderResponse.data?.shipment_id) {
      return await fail({ success: false, message: orderResponse.data?.message || "Shiprocket order creation failed" });
    }

    const { shipment_id } = orderResponse.data;

    // Step 🔟 Assign AWB
    let awb_number = "PENDING";
    let courier_name = null;
    let awbFailureReason = null;
    try {
      const awbResponse = await axios.post(
        `${BASE_URL}/courier/assign/awb`,
        { shipment_id, courier_id: courierService.courier_id },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      console.log("awb response", awbResponse.data)
      awb_number = awbResponse.data?.response?.data?.awb_code || "PENDING";
      courier_name = awbResponse.data?.response?.data?.courier_name || null;
      if (awb_number === "PENDING") awbFailureReason = describeAwbFailure(awbResponse.data);
    } catch (awbErr) {
      console.error("Shiprocket AWB Assignment Error:", awbErr.response?.data || awbErr.message);
      awbFailureReason = awbErr.response?.data ? describeAwbFailure(awbErr.response.data) : awbErr.message;
    }

    if (awb_number === "PENDING") {
      return await fail({
        success: false,
        message: `Failed to assign AWB. Shiprocket order created but AWB assignment failed${awbFailureReason ? ` — ${awbFailureReason}` : ""}.`
      });
    }

    bookedAwb = awb_number;

    let atsLabelUrl = null;
    if (/ats/i.test(courierServiceName || "")) {
      atsLabelUrl = await fetchShiprocketLabelUrl(shipment_id);
    }

    // Step 1️⃣1️⃣ Commit Order status + wallet debit + ledger entry together in
    // one short transaction. Only THIS part is retried on a transient write
    // conflict — Shiprocket has already been called and must not be again.
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;
      const session = await mongoose.startSession();

      try {
        session.startTransaction();

        await Promise.all([
          Order.findByIdAndUpdate(
            id,
            {
              $set: {
                status: "Booked",
                awb_number: awb_number,
                shipment_id: String(shipment_id),
                // Prefer our own curated courier name over Shiprocket's AWB
                // response — Shiprocket's own `courier_name` is its internal
                // display label bundling courier + service tier + weight slab
                // (e.g. "Delhivery DS 500gm", "Shadowfax DS 500"), not a clean
                // courier name. Storing that raw string as `provider` fragments
                // dashboards/reports that group by provider into dozens of
                // "couriers" that are really just Shiprocket's own rate-plan
                // labels for the same handful of real couriers.
                provider: courierService?.courier || courier_name || "Shiprocket",
                partner: "Shiprocket",
                totalFreightCharges: balanceToBeDeducted,
                courierServiceName: courierService.name,
                shipmentCreatedAt: new Date(),
                zone: zone.zone,
                estimatedDeliveryDate: estimateDate,
                priceBreakup,
                ...(atsLabelUrl ? { label: atsLabelUrl } : {}),
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
          ),
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
                channelOrderId: currentOrder.orderId || null,
                category: "debit",
                amount: balanceToBeDeducted,
                balanceAfterTransaction: walletBalance - balanceToBeDeducted,
                date: new Date(),
                awb_number: awb_number,
                description: "Freight Charges Applied",
                priceBreakup,
              }
            ],
            { session }
          )
        ]);

        await session.commitTransaction();
        session.endSession();

        // Trigger background pickup request
        process.nextTick(async () => {
          try {
            await axios.post(`${BASE_URL}/courier/generate/pickup`, { shipment_id: [shipment_id] }, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const fresh = await Order.findById(id);
            if (fresh) await assignPickupManifest(fresh);
          } catch (e) { }
        });

        return {
          success: true,
          message: "Shipment Created Successfully",
          shipment_id: String(shipment_id),
          orderId: currentOrder.orderId,
          awb_number: awb_number,
        };
      } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        session.endSession();

        const isTransient =
          error.errorLabels?.includes("TransientTransactionError") ||
          error.code === 112 ||
          error.message?.includes("WriteConflict");

        if (isTransient && attempt < maxRetries) {
          console.warn(`[API Shiprocket createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          continue;
        }

        // Shiprocket already holds a real shipment (we have its AWB) but
        // Shiproxx failed to record it. Surface it loudly for manual
        // reconciliation, and deliberately do NOT hand the order back as
        // "new": it would show up as bookable again and a retry would create a
        // second shipment (and AWB) at Shiprocket. It stays "processing" —
        // hidden and un-bookable — until reconciled using the AWB below.
        // Nothing was debited (the transaction aborted).
        console.error(
          `🚨 SHIPROCKET ORPHANED SHIPMENT — order ${currentOrder.orderId} booked at Shiprocket with AWB ${awb_number} (shipment ${shipment_id}) but Shiproxx failed to save it after ${attempt} attempts. Left in "processing" so it cannot be booked twice. Manual reconciliation required.`,
          error?.response?.data || error.message
        );
        return {
          success: false,
          message: `Shipment was booked with the courier (AWB ${awb_number}) but could not be saved — please contact support.`,
        };
      }
    }
  } catch (error) {
    if (bookedAwb) {
      // Same rule as above: a real AWB exists, so the order must not become
      // bookable again.
      console.error(`🚨 SHIPROCKET ORPHANED SHIPMENT — order ${currentOrder.orderId} has AWB ${bookedAwb} at Shiprocket but the booking did not complete: ${error.message}. Left in "processing" so it cannot be booked twice. Manual reconciliation required.`);
      return {
        success: false,
        message: `Shipment was booked with the courier (AWB ${bookedAwb}) but could not be saved — please contact support.`,
      };
    }
    await revertOrderToNew(id);

    const errData = error.response?.data;
    console.error("Shiprocket Creation Error:", errData || error.message);

    // Shiprocket rejected the order over its pickup location: our remembered
    // location list is out of date, so forget it.
    if (isPickupLocationError(errData, error.message)) invalidatePickupLocations();

    // Shiprocket's top-level `message` is too generic to act on — the
    // useful detail is in `errors`, a { field: [reasons] } map. Fold it in
    // so the UI shows e.g. "Oops! Invalid Data. — billing_email: The
    // billing email must be a valid email address." instead of just
    // "Invalid Data".
    let detail = errData?.message || error.message;
    if (errData?.errors && typeof errData.errors === "object") {
      const fieldMessages = Object.entries(errData.errors)
        .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : msgs}`)
        .join("; ");
      if (fieldMessages) detail = `${detail} — ${fieldMessages}`;
    }

    return {
      success: false,
      message: detail,
      error: detail,
    };
  }
};

module.exports = createShiprocketShipment;
