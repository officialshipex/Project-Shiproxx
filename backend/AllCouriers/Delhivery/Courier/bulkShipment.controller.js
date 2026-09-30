if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const axios = require("axios");
const { fetchBulkWaybills, getDelhiveryApiKey } = require("../Authorize/saveCourierContoller");
const { getWaybill } = require("../Authorize/waybillPool");
const url = process.env.DELHIVERY_URL;
const Order = require("../../../models/newOrder.model");
const crypto = require("crypto");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const {
  createClientWarehouse,
  getUniqueWarehouseName,
} = require("./couriers.controller");
const { getZone } = require("../../../Rate/zoneManagementController");
const estimatedDeliveryDate = require("../../../models/EDDMap.model");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const createShipmentFunctionDelhivery = async (
  selectedServiceDetails,
  id,
  wh,
  walletId,
  finalCharges,
  priceBreakup
) => {
  const delUrl = `${url}/api/cmu/create.json`;

  try {
    const currentOrder = await Order.findById(id);

    // Fetch API Key for the specific account
    const apiKey = await getDelhiveryApiKey(selectedServiceDetails.courier || selectedServiceDetails.provider);

    // Parallelize getWaybill, getZone and createClientWarehouse
    const [warehouseCreationResult, zone, waybills] = await Promise.all([
      createClientWarehouse(currentOrder.pickupAddress, apiKey),
      getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode),
      getWaybill(apiKey),
    ]);

    if (!zone) {
      return {
        status: 400,
        success: false,
        message: "Pincode not serviceable",
      };
    }

    if (!waybills || !waybills.length) {
      return {
        status: 400,
        success: false,
        message: "No Waybill Available",
      };
    }

    if (!warehouseCreationResult || !warehouseCreationResult.success) {
      return {
        status: 400,
        success: false,
        message: "Failed to create or fetch pickup warehouse",
      };
    }

    const eddData = await estimatedDeliveryDate.findOne({
      courier: "Delhivery",
      serviceName: selectedServiceDetails.name,
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

    const payment_type =
      currentOrder.paymentDetails.method === "COD" ? "COD" : "Prepaid";
    const shipmentType =
      selectedServiceDetails.courierType === "Domestic (Air)"
        ? "Express"
        : "Surface";
    // console.log("warehouse", selectedServiceDetails);
    const payloadData = {
      pickup_location: {
        name:
          warehouseCreationResult.name ||
          warehouseCreationResult.data?.name ||
          getUniqueWarehouseName(currentOrder.pickupAddress) ||
          "Default Warehouse",
      },
      shipments: [
        {
          Waybill: waybills[0],
          country: "India",
          city: currentOrder.receiverAddress.city,
          pin: currentOrder.receiverAddress.pinCode,
          state: currentOrder.receiverAddress.state,
          order: currentOrder.orderId,
          add: currentOrder.receiverAddress.address || "Default Warehouse",
          payment_mode: payment_type,
          shipping_mode: shipmentType,
          quantity: currentOrder.productDetails
            .reduce((sum, product) => sum + product.quantity, 0)
            .toString(),
          phone: currentOrder.receiverAddress.phoneNumber,
          products_desc: currentOrder.productDetails
            .map((product) => product.name)
            .join(", "),
          hsn_code: currentOrder.productDetails
            .map((product) => product.hsn)
            .join(", "),
          total_amount: currentOrder.paymentDetails.amount,
          ewbn:
            currentOrder?.paymentDetails?.amount >= 50000
              ? currentOrder?.otherDetails?.ewaybill
              : "",
          name: currentOrder.receiverAddress.contactName || "Default Warehouse",
          weight: currentOrder.packageDetails.applicableWeight * 1000,
          shipment_height: currentOrder.packageDetails.volumetricWeight.height,
          shipment_width: currentOrder.packageDetails.volumetricWeight.width,
          shipment_length: currentOrder.packageDetails.volumetricWeight.length,
          cod_amount:
            payment_type === "COD"
              ? `${currentOrder.paymentDetails.amount}`
              : "0",
        },
      ],
    };

    const payload = `format=json&data=${encodeURIComponent(
      JSON.stringify(payloadData)
    )}`;

    // Fetch the latest wallet details before proceeding
    let currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    const walletHoldAmount = currentWallet?.holdAmount || 0;
    const effectiveBalance = currentWallet.balance - walletHoldAmount;
    const balance = effectiveBalance + currentWallet.creditLimit;
    if (balance >= finalCharges) {
      const response = await axios.post(delUrl, payload, {
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      if (response.data.success) {
        const result = response.data.packages[0];

        // Update Order Details
        currentOrder.status = "Ready To Ship";
        currentOrder.cancelledAtStage = null;
        currentOrder.awb_number = result.waybill;
        currentOrder.shipment_id = `${result.refnum}`;
        currentOrder.provider = selectedServiceDetails.provider;
        currentOrder.courierName = selectedServiceDetails.courierName || selectedServiceDetails.provider;
        currentOrder.totalFreightCharges =
          finalCharges === "N/A" ? 0 : parseFloat(finalCharges);
        currentOrder.courierServiceName = selectedServiceDetails.name;
        currentOrder.shipmentCreatedAt = new Date();
        currentOrder.estimatedDeliveryDate = estimateDate;
        currentOrder.zone = zone.zone;
        currentOrder.priceBreakup = priceBreakup;
        currentOrder.tracking.push({
          status: "Ready To Ship",
          StatusLocation: currentOrder.pickupAddress?.city || "N/A",
          StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          Instructions: "Order booked successfully",
        });
        await currentOrder.save(); // Save the updated order

        // ── Auto-assign pickup manifest ──
        try {
          await assignPickupManifest(currentOrder);
        } catch (pErr) {
          console.error("[Pickup] assignPickupManifest failed:", pErr.message);
        }

        const updatedWallet = await Wallet.findOneAndUpdate(
          { _id: walletId },
          {
            $inc: { balance: -parseFloat(finalCharges) },
          },
          { new: true }
        );

        await WalletTransaction.create({
          walletId: walletId,
          channelOrderId: currentOrder.orderId,
          category: "debit",
          amount: parseFloat(finalCharges),
          balanceAfterTransaction: updatedWallet ? updatedWallet.balance : (currentWallet.balance - parseFloat(finalCharges)),
          date: new Date(),
          awb_number: result.waybill,
          description: "Freight Charges Applied",
          priceBreakup
        });

        return {
          status: 201,
          message: "Shipment Created Successfully",
          details: response.data,
        };
      } else {
        console.error("Error response from Delhivery:", response.data);
        return {
          status: 400,
          error: "Error creating shipment",
          details: response.data,
        };
      }
    } else {
      return {
        status: 400,
        success: false,
        message: "Insufficient Wallet Balance",
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

module.exports = { createShipmentFunctionDelhivery };
