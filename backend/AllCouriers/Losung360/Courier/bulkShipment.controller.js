const Wallet = require("../../../models/wallet");
const CourierService = require("../../../models/CourierService.Schema");
const createLosung360Shipment = require("../../../API/Courier/losung360ShipmentCreation.controller");

/**
 * Losung360 Bulk Shipment Controller
 */
const createOrderLosung360 = async (
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

    // 2. Fetch specific partner service mapping
    const courierService = await CourierService.findOne({
      name: serviceDetails.name,
      provider: "Losung360",
    });

    const partnerServiceId = courierService ? courierService.courier_id : null;

    // 3. Delegate to the main transactional helper
    const result = await createLosung360Shipment({
      id,
      provider: "Losung360",
      finalCharges,
      courierServiceName: serviceDetails.name,
      partnerServiceId,
      priceBreakup,
      userId: null, // userId is loaded inside createLosung360Shipment using mongoose query
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
        message: result.message || "Failed to create shipment via Losung360",
      };
    }
  } catch (error) {
    console.error("Losung360 Bulk Shipment Error:", error.message);
    return {
      status: 500,
      success: false,
      message: error.message,
    };
  }
};

module.exports = { createOrderLosung360 };
