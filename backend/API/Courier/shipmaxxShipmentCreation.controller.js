const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");
const { getZone } = require("../../Rate/zoneManagementController");
const { getShipMaxxToken, SHIPMAXX_BASE_URL } = require("../../AllCouriers/ShipMaxx/Authorize/shipmaxx.controller");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");
const PickupAddress = require("../../models/pickupAddress.model");

// Set by ShipMaxx/Losung360 support when the seller account was provisioned —
// there is no API to look this up, it's fixed per company account.
const SHIPMAXX_CHANNEL_ID = Number(process.env.SHIPMAXX_CHANNEL_ID) || 1;

const getShipMaxxWarehouseId = async (userId, pickupAddressData, token) => {
  try {
    // 1. Find the pickupAddress document in our database for this specific order/user
    let dbPickupAddress = await PickupAddress.findOne({
      userId,
      "pickupAddress.pinCode": pickupAddressData.pinCode,
      "pickupAddress.address": pickupAddressData.address,
    });

    if (!dbPickupAddress) {
      console.warn(`No pickupAddress document found in DB for user ${userId} and pincode ${pickupAddressData.pinCode}. Creating one...`);

      const userDoc = await User.findById(userId);
      const email = pickupAddressData.email || userDoc?.email || `${userId}@shiproxx.com`;

      dbPickupAddress = new PickupAddress({
        userId,
        isPrimary: false,
        pickupAddress: {
          contactName: pickupAddressData.contactName || "Contact Person",
          email: email,
          phoneNumber: pickupAddressData.phoneNumber || "9999999999",
          address: pickupAddressData.address,
          pinCode: pickupAddressData.pinCode,
          city: pickupAddressData.city,
          state: pickupAddressData.state,
        },
        shipmaxxWarehouseId: "",
      });
      await dbPickupAddress.save();
      console.log(`Successfully created new pickupAddress document: ${dbPickupAddress._id}`);
    }

    if (dbPickupAddress.shipmaxxWarehouseId) {
      return Number(dbPickupAddress.shipmaxxWarehouseId);
    }

    // 2. Check if any other pickup address document in the DB has already registered this location on ShipMaxx
    const existingWithId = await PickupAddress.findOne({
      "pickupAddress.pinCode": pickupAddressData.pinCode,
      "pickupAddress.address": pickupAddressData.address,
      shipmaxxWarehouseId: { $ne: "", $exists: true },
    });

    if (existingWithId && existingWithId.shipmaxxWarehouseId) {
      console.log(`Found existing ShipMaxx warehouse ID ${existingWithId.shipmaxxWarehouseId} in DB from another document.`);
      dbPickupAddress.shipmaxxWarehouseId = existingWithId.shipmaxxWarehouseId;
      await dbPickupAddress.save();
      return Number(existingWithId.shipmaxxWarehouseId);
    }

    // 3. Generate a completely unique warehouse name using the database document's _id to prevent duplicate name (400) errors
    const baseName = (pickupAddressData.contactName || "WH").replace(/[^a-zA-Z0-9]/g, "").substring(0, 10);
    const uniqueWarehouseName = `${baseName}-${dbPickupAddress._id.toString()}`.substring(0, 30);

    const warehousePayload = {
      name: uniqueWarehouseName,
      address: pickupAddressData.address,
      city: pickupAddressData.city,
      state: pickupAddressData.state,
      pincode: String(pickupAddressData.pinCode),
      contact_person: pickupAddressData.contactName || "Contact Person",
      contact_number: pickupAddressData.phoneNumber ? pickupAddressData.phoneNumber.replace(/^0+/, "") : "9999999999",
    };

    console.log("ShipMaxx Create Warehouse Payload:", JSON.stringify(warehousePayload, null, 2));

    try {
      const response = await axios.post(
        `${SHIPMAXX_BASE_URL}/warehouses/create`,
        warehousePayload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );

      console.log("ShipMaxx Create Warehouse Response:", response.data);

      if (response.data && response.data.id) {
        dbPickupAddress.shipmaxxWarehouseId = String(response.data.id);
        await dbPickupAddress.save();
        return Number(response.data.id);
      }
    } catch (e) {
      console.warn("ShipMaxx Create Warehouse API Error:", e.response?.data || e.message);

      // Unlike some other aggregators, ShipMaxx's 400 (duplicate name) and 409
      // (duplicate location) error bodies include the existing warehouse's
      // `warehouse_id` directly — reuse it instead of failing the booking.
      const status = e.response?.status;
      const existingId = e.response?.data?.warehouse_id;
      if ((status === 400 || status === 409) && existingId) {
        console.warn(`ShipMaxx warehouse already exists (status ${status}) — reusing warehouse_id ${existingId}.`);
        dbPickupAddress.shipmaxxWarehouseId = String(existingId);
        await dbPickupAddress.save();
        return Number(existingId);
      }
    }

    return null;
  } catch (error) {
    console.error("Error in getShipMaxxWarehouseId:", error.message);
    return null;
  }
};

const createShipMaxxShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  carrierVariantId,
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

      // Step 1: Fetch order & mark as processing
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
          message:
            "Shipment cannot be created because order is already processed or not in 'new' status.",
        };
      }

      // Step 2: Wallet check
      if (!walletId) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Wallet not found" };
      }

      // Step 3: Wallet Balance Check
      const effectiveBalance = walletBalance - (walletHoldAmount || 0);
      const balanceToBeDeducted = finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
      const totalBalance = effectiveBalance + (walletCreditLimit || 0);

      if (totalBalance < balanceToBeDeducted) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Insufficient Wallet Balance" };
      }

      // Step 4: Get Zone
      const zone = await getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      );

      if (!zone) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "Pincode not serviceable" };
      }

      // Step 5: Fetch estimated delivery date from DB
      const eddData = await estimatedDeliveryDate.findOne({
        courier: "ShipMaxx",
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

      // Step 6: Authenticate with ShipMaxx
      const token = await getShipMaxxToken();

      if (!token) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "ShipMaxx authentication failed" };
      }

      // Step 7: Create/Resolve Warehouse in ShipMaxx
      const pickupAddressId = await getShipMaxxWarehouseId(currentOrder.userId, currentOrder.pickupAddress, token);

      if (!pickupAddressId) {
        await session.abortTransaction();
        session.endSession();
        return { success: false, message: "ShipMaxx pickup address registration failed" };
      }

      const orderPayload = {
        pickup_address_id: pickupAddressId,
        channel_id: SHIPMAXX_CHANNEL_ID,
        payment_method: currentOrder.paymentDetails?.method === "COD" ? "cod" : "prepaid",
        order_number: String(currentOrder.orderId),
        customer: {
          name: currentOrder.receiverAddress.contactName || "Customer",
          phone: currentOrder.receiverAddress.phoneNumber?.replace(/^0+/, "") || "9999999999",
          email: currentOrder.receiverAddress.email || "customer@example.com",
          address: currentOrder.receiverAddress.address || "N/A",
          landmark: currentOrder.receiverAddress.landmark || "",
          pincode: String(currentOrder.receiverAddress.pinCode),
          city: currentOrder.receiverAddress.city || "N/A",
          state: currentOrder.receiverAddress.state || "N/A",
        },
        products: currentOrder.productDetails.map((p) => ({
          sku: p.sku || `SKU-${currentOrder.orderId}`,
          name: p.name || "Product",
          price: Number(p.unitPrice) || 0,
          quantity: Number(p.quantity) || 1,
        })),
        package: {
          weight: Number(currentOrder.packageDetails.applicableWeight) || 0.5,
          length: Number(currentOrder.packageDetails.length) || 10,
          width: Number(currentOrder.packageDetails.width) || 10,
          height: Number(currentOrder.packageDetails.height) || 10,
        },
        other_charges: 0,
        total_discount: 0,
      };

      console.log("ShipMaxx Create Order Payload:", JSON.stringify(orderPayload, null, 2));

      const orderResponse = await axios.post(`${SHIPMAXX_BASE_URL}/orders/create`, orderPayload, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      });
      console.log("ShipMaxx Create Order Response:", orderResponse.data);

      if (orderResponse.data?.status !== "success" || !orderResponse.data?.data?.order_id) {
        throw new Error(orderResponse.data?.message || "ShipMaxx order creation failed");
      }

      const externalOrderId = orderResponse.data.data.order_id;

      // Step 8: Create Shipment in ShipMaxx
      const shipmentPayload = {
        order_id: String(externalOrderId),
      };

      if (carrierVariantId) {
        shipmentPayload.carrier_variant_id = Number(carrierVariantId);
      }

      console.log("ShipMaxx Create Shipment Payload:", JSON.stringify(shipmentPayload, null, 2));

      const shipmentResponse = await axios.post(`${SHIPMAXX_BASE_URL}/shipping/create-shipment`, shipmentPayload, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      });
      console.log("ShipMaxx Create Shipment Response:", shipmentResponse.data);

      if (!shipmentResponse.data || shipmentResponse.data.success !== true || !shipmentResponse.data.awb) {
        throw new Error(shipmentResponse.data?.detail || "ShipMaxx shipment creation failed");
      }

      const { awb, courier_name, label_url } = shipmentResponse.data;
      const finalProviderName = courier_name ? (courier_name.charAt(0).toUpperCase() + courier_name.slice(1).toLowerCase()) : "ShipMaxx";

      // Step 9: Update Order & Wallet atomically
      await Promise.all([
        Order.findByIdAndUpdate(
          id,
          {
            $set: {
              status: "Booked",
              cancelledAtStage: null,
              awb_number: awb,
              shipment_id: String(externalOrderId),
              provider: finalProviderName,
              partner: "ShipMaxx",
              totalFreightCharges: balanceToBeDeducted,
              courierServiceName,
              shipmentCreatedAt: new Date(),
              zone: zone.zone,
              estimatedDeliveryDate: estimateDate,
              priceBreakup,
              ...(label_url ? { label: label_url } : {}),
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
              awb_number: awb || "",
              description: "Freight Charges Applied",
              priceBreakup,
            },
          ],
          { session }
        ),
      ]);

      await session.commitTransaction();
      session.endSession();

      // ── Auto-assign pickup manifest (non-blocking) ──
      Order.findById(id)
        .then((freshOrder) => {
          if (freshOrder) assignPickupManifest(freshOrder);
        })
        .catch((pErr) => {
          console.error("[Pickup] assignPickupManifest failed:", pErr.message);
        });

      return {
        success: true,
        message: "Shipment Created Successfully",
        awb_number: awb,
        orderId: currentOrder.orderId,
        estimatedDeliveryDate: estimateDate,
      };
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();

      const isTransient =
        error.errorLabels?.includes("TransientTransactionError") ||
        error.code === 112 ||
        error.message?.includes("WriteConflict");

      if (isTransient && attempt < maxRetries) {
        console.warn(`[API ShipMaxx createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }

      console.error("ShipMaxx Creation Error:", error.response?.data || error.message);

      let errMsg = "Error creating shipment";
      if (error.response?.data) {
        const data = error.response.data;
        if (typeof data.detail === "string") {
          errMsg = data.detail;
        } else if (data.detail && typeof data.detail === "object") {
          errMsg = data.detail.message || data.detail.detail || JSON.stringify(data.detail);
        } else if (typeof data.message === "string") {
          errMsg = data.message;
          if (data.errors && typeof data.errors === "object") {
            const fieldErrors = Object.entries(data.errors)
              .map(([field, err]) => `${field}: ${err}`)
              .join(", ");
            if (fieldErrors) {
              errMsg += ` (${fieldErrors})`;
            }
          }
        } else if (typeof data === "string") {
          errMsg = data;
        }
      } else {
        errMsg = error.message || errMsg;
      }

      return {
        success: false,
        message: errMsg,
      };
    }
  }
};

module.exports = createShipMaxxShipment;
