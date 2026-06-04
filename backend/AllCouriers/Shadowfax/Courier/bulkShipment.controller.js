const axios = require("axios");
const { getShadowfaxToken } = require("../Authorize/saveCourierController");
const Order = require("../../../models/newOrder.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const SHADOWFAX_BASE_URL = process.env.SHADOWFAX_URL || "https://dale.shadowfax.in/api";

/**
 * Shadowfax Bulk Shipment Controller
 */
const createOrderShadowfax = async (
  selectedServiceDetails,
  id,
  wh,
  walletId,
  finalCharges,
  priceBreakup
) => {
  try {
    const currentOrder = await Order.findById(id);
    if (!currentOrder) return { status: 404, message: "Order not found" };

    const apiKey = await getShadowfaxToken(selectedServiceDetails.courier || selectedServiceDetails.provider);
    if (!apiKey) return { status: 401, message: "Shadowfax API Token not found" };

    const zone = await getZone(
      currentOrder.pickupAddress.pinCode,
      currentOrder.receiverAddress.pinCode
    );

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Shadowfax",
      serviceName: selectedServiceDetails.name,
    });

    let estimateDate = null;
    if (eddData && zone) {
      const deliveryDays = eddData.zoneRates?.[zone.zone] || eddData[zone.zone];
      if (deliveryDays) {
        estimateDate = new Date();
        estimateDate.setDate(estimateDate.getDate() + deliveryDays);
      }
    }

    // Wallet check with credit limit
    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const totalBalance = effectiveBalance + (currentWallet.creditLimit || 0);

    if (totalBalance < finalCharges) {
      return { status: 400, success: false, message: "Insufficient Wallet Balance" };
    }

    // Prepare Payload
    const sender = currentOrder.pickupAddress || {};
    const receiver = currentOrder.receiverAddress || {};
    const product = currentOrder.productDetails?.[0] || {};

    const paymentMode = currentOrder.paymentDetails.method === "COD" ? "COD" : "Prepaid";
    const weightGrams = Math.round(parseFloat(currentOrder.packageDetails.applicableWeight || 0.5) * 1000);

    const sfxPayload = {
      order_type: "warehouse",
      order_details: {
        client_order_id: currentOrder.orderId,
        actual_weight: weightGrams,
        volumetric_weight: weightGrams,
        product_value: parseFloat(currentOrder.paymentDetails.amount || 0),
        payment_mode: paymentMode,
        cod_amount: paymentMode === "COD" ? parseFloat(currentOrder.paymentDetails.amount || 0) : 0,
        order_service: "regular",
        total_amount: parseFloat(currentOrder.paymentDetails.amount || 0),
      },
      customer_details: {
        name: receiver.contactName || receiver.name || "Customer",
        contact: String(receiver.phoneNumber || "").replace(/\D/g, "").slice(-10),
        address_line_1: receiver.address || "",
        city: receiver.city || "",
        state: receiver.state || "",
        pincode: parseInt(receiver.pinCode || 0),
      },
      pickup_details: {
        name: sender.contactName || sender.name || "Seller",
        contact: String(sender.phoneNumber || "").replace(/\D/g, "").slice(-10),
        address_line_1: sender.address || "",
        city: sender.city || "",
        state: sender.state || "",
        pincode: parseInt(sender.pinCode || 0),
      },
      rto_details: {
        name: sender.contactName || sender.name || "Seller",
        contact: String(sender.phoneNumber || "").replace(/\D/g, "").slice(-10),
        address_line_1: sender.address || "",
        city: sender.city || "",
        state: sender.state || "",
        pincode: parseInt(sender.pinCode || 0),
      },
      product_details: [
        {
          sku_name: product.name || "Product",
          price: parseFloat(product.price || 0),
          category: "General",
          invoice_no: currentOrder.orderId,
          additional_details: { quantity: parseInt(product.quantity || 1) },
        },
      ],
    };

    const response = await axios.post(`${SHADOWFAX_BASE_URL}/v3/clients/orders/`, sfxPayload, {
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    if (response.data.message === "Success" && response.data.data?.awb_number) {
      const awb = response.data.data.awb_number;

      // Update Order
      currentOrder.status = "Booked";
      currentOrder.awb_number = awb;
      currentOrder.provider = "Shadowfax";
      currentOrder.courierName = selectedServiceDetails.courierName || "Shadowfax";
      currentOrder.totalFreightCharges = parseFloat(finalCharges);
      currentOrder.courierServiceName = selectedServiceDetails.name;
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.estimatedDeliveryDate = estimateDate;
      currentOrder.zone = zone?.zone;
      currentOrder.priceBreakup = priceBreakup;
      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: sender.city || "N/A",
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        Instructions: "Order booked successfully",
      });
      await currentOrder.save();

      // Update Wallet
      const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: walletId },
        {
          $inc: { balance: -parseFloat(finalCharges) },
        },
        { new: true }
      );

      // 🔁 Dual-write: mirror to WalletTransaction for future migration
      if (updatedWallet) {
        await WalletTransaction.create({
          walletId: updatedWallet._id,
          channelOrderId: currentOrder.orderId,
          category: "debit",
          amount: parseFloat(finalCharges),
          balanceAfterTransaction: updatedWallet.balance,
          date: new Date(),
          awb_number: awb,
          description: "Freight Charges Applied",
          priceBreakup,
        });
      }

      // Auto-assign pickup manifest
      try {
        await assignPickupManifest(currentOrder);
      } catch (pErr) {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      }

      return { status: 201, success: true, message: "Shipment Created Successfully", awb };
    } else {
      return { status: 400, success: false, message: response.data.message || "Failed to create shipment" };
    }
  } catch (error) {
    console.error("Shadowfax Bulk Shipment Error:", error.message);
    return { status: 500, success: false, message: error.message };
  }
};

module.exports = { createOrderShadowfax };
