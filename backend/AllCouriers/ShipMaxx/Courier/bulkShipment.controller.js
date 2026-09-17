const Wallet = require("../../../models/wallet");
const CourierService = require("../../../models/CourierService.Schema");
const createShipMaxxShipment = require("../../../API/Courier/shipmaxxShipmentCreation.controller");

const createOrderShipMaxx = async (
  serviceDetails,
  id,
  wh,
  walletId,
  finalCharges,
  priceBreakup
) => {
  try {
    // 1. Fetch wallet state
    const currentWallet = await Wallet.findById(walletId).select("balance holdAmount creditLimit");
    if (!currentWallet) {
      return { success: false, message: "Wallet not found" };
    }

    // 2. Fetch specific carrier variant id
    const courierService = await CourierService.findOne({
      name: serviceDetails.name,
      provider: "ShipMaxx",
    });

    const carrierVariantId = courierService ? courierService.courier : null;

    // 3. Delegate to the main transactional helper
    const result = await createShipMaxxShipment({
      id,
      provider: "ShipMaxx",
      finalCharges,
      courierServiceName: serviceDetails.name,
      carrierVariantId,
      priceBreakup,
      userId: null, // userId is loaded inside createShipMaxxShipment using mongoose query
      walletId,
      walletBalance: currentWallet.balance,
      walletHoldAmount: currentWallet.holdAmount || 0,
      walletCreditLimit: currentWallet.creditLimit || 0,
    });

    // Translate output to bulk processor format
    if (result.success) {
      return {
        status: 201,
        success: true,
        message: "Shipment Created Successfully",
        awb: result.awb_number,
      };
    } else {
      return {
        status: 400,
        success: false,
        message: result.message || "Failed to create shipment via ShipMaxx",
      };
    }
  } catch (error) {
    console.error("ShipMaxx Bulk Shipment Error:", error.message);
    return {
      status: 500,
      success: false,
      message: error.message,
    };
  }
};

module.exports = { createOrderShipMaxx };
