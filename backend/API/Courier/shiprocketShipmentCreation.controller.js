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
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // Step 1️⃣ Fetch order & mark as processing
      const currentOrder = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true, session }
      );

      if (!currentOrder) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Shipment already created or order not in 'new' status." };
      }

      // Step 2️⃣ Wallet check
      if (!walletId) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Wallet not found" };
      }

      // Step 3️⃣ Wallet Balance Check
      const effectiveBalance = walletBalance - (walletHoldAmount || 0);
      const balanceToBeDeducted = parseFloat(finalCharges) || 0;
      const totalBalance = effectiveBalance + (walletCreditLimit || 0);

      if (totalBalance < balanceToBeDeducted) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Insufficient Wallet Balance" };
      }


      // Step 4️⃣ Get Zone
      const zone = await getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode);
      if (!zone) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Pincode not serviceable" };
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
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "ShipRocket authentication failed" };
      }

      // Step 7️⃣ Add/Verify Pickup Location in Shiprocket
      let pickupLocationName = currentOrder.pickupAddress.contactName;
      try {
        // Fetch existing pickup locations to see if one matches this pincode
        const pickupResponse = await axios.get(`${BASE_URL}/settings/company/pickup`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000
        });

        let existingLocations = [];
        if (pickupResponse.data?.data?.shipping_address && Array.isArray(pickupResponse.data.data.shipping_address)) {
          existingLocations = pickupResponse.data.data.shipping_address;
        } else if (pickupResponse.data?.data && Array.isArray(pickupResponse.data.data)) {
          existingLocations = pickupResponse.data.data;
        } else if (pickupResponse.data && Array.isArray(pickupResponse.data)) {
          existingLocations = pickupResponse.data;
        } else if (pickupResponse.data?.shipping_address && Array.isArray(pickupResponse.data.shipping_address)) {
          existingLocations = pickupResponse.data.shipping_address;
        }
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
        }
      } catch (e) {
        console.error("Shiprocket Pickup Location Sync Error:", e.response?.data || e.message);
        // If adding fails for validation (like address length), we must stop and inform the user
        if (e.response?.status !== 422) {
          await session.abortTransaction();
          session.endSession();
          let errMsg = "Shiprocket Pickup Location Error";
          if (e.response?.data?.message) {
            try {
              const parsed = JSON.parse(e.response.data.message);
              if (parsed.address) errMsg += ": " + parsed.address.join(" ");
            } catch (err) {
              errMsg += ": " + e.response.data.message;
            }
          }
          return { success: false, message: errMsg };
        }
      }

      // Step 8️⃣ Prepare Shiprocket Payload
      const senderName = splitName(currentOrder.pickupAddress.contactName);
      const receiverName = splitName(currentOrder.receiverAddress.contactName);
      const isCOD = currentOrder.paymentDetails.method === "COD";

      const shiprocketPayload = {
        order_id: String(currentOrder.orderId),
        order_date: getCurrentDateTime(),
        pickup_location: pickupLocationName,
        billing_customer_name: senderName.first,
        billing_last_name: senderName.last,
        billing_address: ensureAddress(currentOrder.pickupAddress.address),
        billing_city: currentOrder.pickupAddress.city,
        billing_pincode: String(currentOrder.pickupAddress.pinCode),
        billing_state: currentOrder.pickupAddress.state,
        billing_country: "India",
        billing_email: currentOrder.pickupAddress.email || SHIPROCKET_EMAIL,
        billing_phone: cleanPhone(currentOrder.pickupAddress.phoneNumber),
        shipping_is_billing: false,
        shipping_customer_name: receiverName.first,
        shipping_last_name: receiverName.last,
        shipping_address: ensureAddress(currentOrder.receiverAddress.address),
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

      // Step 9️⃣ Create Order in Shiprocket
      const orderResponse = await axios.post(`${BASE_URL}/orders/create/adhoc`, shiprocketPayload, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      });

      console.log("response data", orderResponse.data, orderResponse.data.data)

      if (!orderResponse.data?.shipment_id) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: orderResponse.data?.message || "Shiprocket order creation failed" };
      }

      const { shipment_id } = orderResponse.data;

      // Step 🔟 Assign AWB
      let awb_number = "PENDING";
      try {
        const courierService = await require("../../models/CourierService.Schema").findOne({
          name: courierServiceName,
          provider: "Shiprocket",
        });

        if (courierService?.courier_id) {
          const awbResponse = await axios.post(
            `${BASE_URL}/courier/assign/awb`,
            { shipment_id, courier_id: courierService.courier_id },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
          );
          console.log("awb response", awbResponse.data)
          awb_number = awbResponse.data?.response?.data?.awb_code || "PENDING";
        } else {
          // Fallback: auto-assign if no ID is found (optional, or could error)
          const awbResponse = await axios.post(
            `${BASE_URL}/courier/assign/awb`,
            { shipment_id },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
          );
          console.log("awb response (auto-assign)", awbResponse.data)
          awb_number = awbResponse.data?.response?.data?.awb_code || "PENDING";
        }
      } catch (awbErr) {
        console.error("Shiprocket AWB Assignment Error:", awbErr.response?.data || awbErr.message);
      }

      if (awb_number === "PENDING") {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message: "Failed to assign AWB. Shiprocket order created but AWB assignment is pending/failed."
        };
      }

      // Update Order & Wallet
      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              awb_number: awb_number,
              shipment_id: String(shipment_id),
              provider: "Shiprocket",
              partner: "Shiprocket",
              totalFreightCharges: balanceToBeDeducted,
              courierServiceName,
              shipmentCreatedAt: new Date(),
              zone: zone.zone,
              estimatedDeliveryDate: estimateDate,
              priceBreakup,
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

      console.error("Shiprocket Creation Error:", error.response?.data || error.message);
      return {
        success: false,
        message: "Error creating shipment",
        error: error.response?.data?.message || error.message,
      };
    }
  }
};

module.exports = createShiprocketShipment;
