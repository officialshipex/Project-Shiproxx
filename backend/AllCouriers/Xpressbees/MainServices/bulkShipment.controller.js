if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}

const axios = require("axios");

const Order = require("../../../models/newOrder.model");
const { getAuthToken } = require("../Authorize/XpressbeesAuthorize.controller");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const BASE_URL = process.env.XpreesbeesUrl;

const createShipmentFunctionXpressBees = async (
  selectedServiceDetails,
  id,
  wh,
  walletId,
  finalCharges
) => {
  try {
    const currentOrder = await Order.findById(id);
    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (currentOrder.status !== "new") {
      return {
        status: 400,
        success: false,
        message: `Shipment cannot be created because order status is '${currentOrder.status}'.`,
      };
    }
    const order_items = currentOrder.Product_details.map((item) => ({
      name: item.product,
      qty: item.quantity,
      price: item.amount,
      sku: item.sku,
    }));

    const payment_type =
      currentOrder.order_type === "Cash on Delivery" ? "cod" : "prepaid";

    const shipmentData = {
      order_number: `${currentOrder.order_id}`,
      payment_type,
      order_amount: currentOrder.sub_total,
      consignee: {
        name: `${currentOrder.shipping_details.firstName} ${currentOrder.shipping_details.lastName}`,
        address: `${currentOrder.shipping_details.address} ${currentOrder.shipping_details.address2}`,
        city: currentOrder.shipping_details.city,
        state: currentOrder.shipping_details.state,
        pincode: `${currentOrder.shipping_details.pinCode}`,
        phone: currentOrder.shipping_details.phone,
      },
      pickup: {
        warehouse_name: wh.warehouseName,
        name: wh.contactName,
        address: `${wh.addressLine1} ${wh.addressLine2}`,
        city: wh.city,
        state: wh.state,
        pincode: wh.pinCode,
        phone: parseInt(wh.contactNo),
      },
      order_items,
      collectable_amount: currentOrder.sub_total,
      courier_id: selectedServiceDetails.provider_courier_id,
    };

    const token = await getAuthToken();
    let response;
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    if (effectiveBalance >= finalCharges) {
      response = await axios.post(`${BASE_URL}/api/shipments2`, shipmentData, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } else {
      return res.status(400).json({ success: false, message: "Low Balance" });
    }

    if (response.data.status) {
      const result = response.data.data;

      currentOrder.status = "Ready To Ship";
      currentOrder.cancelledAtStage = null;
      currentOrder.awb_number = result.awb_number;
      currentOrder.shipment_id = `${result.awb_number}`;
      currentOrder.service_details = selectedServiceDetails._id;
      currentOrder.freightCharges =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      currentOrder.tracking = [{ stage: "Order Booked" }];
      await currentOrder.save();

      // ── Auto-assign pickup manifest ──
      try {
        await assignPickupManifest(currentOrder);
      } catch (pErr) {
        console.error("[Pickup] assignPickupManifest failed:", pErr.message);
      }

      const balanceToBeDeducted =
        finalCharges === "N/A" ? 0 : parseInt(finalCharges);
      const currentBalance = currentWallet.balance - balanceToBeDeducted;

      await currentWallet.updateOne({
        $inc: { balance: -balanceToBeDeducted },
      });

      // 🔁 Dual-write: mirror to WalletTransaction for future migration
      await WalletTransaction.create({
        walletId: currentWallet._id,
        category: "debit",
        amount: balanceToBeDeducted,
        balanceAfterTransaction: currentBalance,
        awb_number: `${result.awb_number}`,
        date: new Date(),
        description: "Freight Charges Applied",
      });

      return { status: 201, message: "Shipment Created Successfully" };
    } else {
      return {
        status: 400,
        error: "Error creating shipment",
        details: response.data,
      };
    }
  } catch (error) {
    console.error("Error in creating shipment:", error.message);
    return {
      status: 500,
      error: "Internal Server Error",
      message: error.message,
    };
  }
};

module.exports = { createShipmentFunctionXpressBees };
