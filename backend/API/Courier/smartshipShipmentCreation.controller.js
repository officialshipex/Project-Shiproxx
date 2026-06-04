const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const {
  registerSmartshipHub,
} = require("../../AllCouriers/SmartShip/Couriers/couriers.controller");
const {
  getAccessToken,
} = require("../../AllCouriers/SmartShip/Authorize/smartShip.controller");
const mongoose = require("mongoose");
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");
/**
 * Registers order shipment in one step with Smartship
 *
 * @param {object} params
 * @param {string} params.id - Order ID
 * @param {string|number} params.finalCharges - Final freight charge amount
 * @param {string} params.courierServiceName - Courier service name
 * @param {string} params.provider - Provider name
 * @returns {Promise<object>} Result with success status and data or error details
 */
const createSmartshipShipment = async ({
  id,
  finalCharges,
  courierServiceName,
  provider,
  priceBreakup,
  userId,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1️⃣ Fetch and lock the order for processing
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
          "Shipment already created or order is being processed by another request.",
      };
    }

    // 2️⃣ Parallel fetch (zone, token)
    const [zone, accessToken] = await Promise.all([
      getZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      ),
      getAccessToken(),
    ]);

    if (!zone) {
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Pincode not serviceable" };
    }

    // ✅ Estimate Delivery Date (from DB)
    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Smartship",
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

    // 3️⃣ Check wallet balance
    const effectiveBalance = walletBalance - walletHoldAmount;
    const balance = effectiveBalance + walletCreditLimit;
    if (balance < finalCharges) {
      await session.abortTransaction();
      session.endSession();
      return { success: false, message: "Insufficient Wallet Balance" };
    }

    // 4️⃣ Register Smartship hub
    const smartshipHub = await registerSmartshipHub(
      userId,
      currentOrder.pickupAddress.pinCode
    );

    if (smartshipHub?.success === false) {
      await session.abortTransaction();
      session.endSession();
      return {
        success: false,
        message:
          "Pickup pincode not registered. Please add a pickup address first.",
      };
    }

    // 5️⃣ Prepare Smartship payload
    const payload = {
      request_info: { run_type: "create" },
      orders: [
        {
          client_order_reference_id: currentOrder.orderId,
          shipment_type: 1,
          order_collectable_amount:
            currentOrder.paymentDetails.method === "COD"
              ? currentOrder.paymentDetails.amount
              : 0,
          total_order_value: currentOrder.paymentDetails.amount.toString(),
          payment_type: currentOrder.paymentDetails.method.toLowerCase(),
          package_order_weight: (
            currentOrder.packageDetails.applicableWeight * 1000
          ).toString(),
          package_order_length:
            currentOrder.packageDetails.volumetricWeight.length.toString(),
          package_order_height:
            currentOrder.packageDetails.volumetricWeight.height.toString(),
          package_order_width:
            currentOrder.packageDetails.volumetricWeight.width.toString(),
          shipper_hub_id: smartshipHub.hubId || "",
          order_invoice_date: new Date().toISOString().slice(0, 10),
          order_invoice_number: `INV-${currentOrder.orderId}-${Date.now()}`,
          is_return_qc: "0",
          return_reason_id: "0",
          order_meta: { preferred_carriers: [279] }, // Modify carrier ID if needed
          product_details: currentOrder.productDetails.map((p) => ({
            client_product_reference_id: p._id.toString(),
            product_name: p.name,
            product_category: p.category || "General",
            product_hsn_code: p.hsn || "0000",
            product_quantity: p.quantity || 1,
            product_gst_tax_rate: p.gst || "0",
            product_invoice_value: p.unitPrice.toString(),
          })),
          consignee_details: {
            consignee_name: currentOrder.receiverAddress.contactName,
            consignee_phone: currentOrder.receiverAddress.phoneNumber,
            consignee_email:
              currentOrder.receiverAddress.email || "noemail@example.com",
            consignee_complete_address: currentOrder.receiverAddress.address,
            consignee_pincode: currentOrder.receiverAddress.pinCode,
          },
        },
      ],
    };

    // 6️⃣ Call Smartship API
    const response = await axios.post(
      "https://api.smartship.in/v2/app/Fulfillmentservice/orderRegistrationOneStep",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const respData = response.data?.data;

    if (respData?.errors) {
      throw new Error("Smartship returned validation errors");
    }

    if (
      !respData?.success_order_details?.orders?.length &&
      respData?.duplicate_orders
    ) {
      throw new Error(
        "Duplicate orderId not allowed for this courier. Try a different courier."
      );
    }

    const result = respData?.success_order_details?.orders?.[0];
    if (!result?.awb_number) throw new Error("AWB not received from Smartship");

    // 7️⃣ Update order and wallet in transaction
    await Order.updateOne(
      { _id: currentOrder._id },
      {
        $set: {
          status: "Booked",
          awb_number: result.awb_number,
          shipment_id: result.request_order_id || "",
          provider,
          totalFreightCharges: parseFloat(finalCharges),
          courierServiceName,
          shipmentCreatedAt: new Date(),
          zone: zone.zone,
          estimatedDeliveryDate: estimateDate, // ✅ from DB
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
      { session }
    );

    await Promise.all([
      Wallet.updateOne(
        { _id: walletId },
        {
          $inc: { balance: -parseFloat(finalCharges) },
        },
        { session }
      ),
      WalletTransaction.create(
        [
          {
            walletId: walletId,
            channelOrderId: currentOrder.orderId,
            category: "debit",
            amount: parseFloat(finalCharges),
            balanceAfterTransaction: walletBalance - parseFloat(finalCharges),
            date: new Date(),
            awb_number: result.awb_number,
            description: `Freight Charges Applied`,
            priceBreakup
          }
        ],
        { session }
      )
    ]);

    await session.commitTransaction();
    session.endSession();

    // ── Auto-assign pickup manifest (non-blocking) ──
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
      awb_number: result.awb_number,
    };
  } catch (error) {
    console.error("Smartship Shipment Error:", error.message);

    await session.abortTransaction();
    session.endSession();

    // revert order status if locked
    if (id) {
      await Order.updateOne(
        { _id: id, status: "processing" },
        { $set: { status: "new" } }
      );
    }

    return {
      success: false,
      message: "Failed to register Smartship order",
      error: error?.response?.data || error.message,
    };
  }
};

module.exports = createSmartshipShipment;
