const user = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const Order = require("../../models/newOrder.model");
const {
  cancelOrderDelhivery,
} = require("../../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  cancelOrderDTDC,
} = require("../../AllCouriers/DTDC/Courier/couriers.controller");
const {
  cancelSmartshipOrder,
} = require("../../AllCouriers/SmartShip/Couriers/couriers.controller");
const {
  cancelShipment,
} = require("../../AllCouriers/Amazon/Courier/couriers.controller");
const {
  cancelOrderZipypost,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");
// Assuming other cancel functions are imported similarly

const mongoose = require("mongoose");
const {
  cancelOrderShreeMaruti,
} = require("../../AllCouriers/ShreeMaruti/Couriers/couriers.controller");
const { cancelShipmentEkart } = require("../../AllCouriers/Ekart/Couriers/couriers.controller");
const {
  cancelOrderBoxdLogistics,
} = require("../../AllCouriers/BoxdLogistics/Courier/couriers.controller");
const {
  cancelProshipOrder,
} = require("../../AllCouriers/Proship/Courier/couriers.controller");
const {
  cancelShadowfaxOrder,
} = require("../../AllCouriers/Shadowfax/Courier/couriers.controller");
const {
  cancelLosung360Order,
} = require("../../AllCouriers/Losung360/Courier/couriers.controller");
const {
  cancelOrder: cancelShiprocketOrder,
} = require("../../AllCouriers/ShipRocket/Courier/couriers.controller");
const {
  cancelShipexIndiaOrder,
} = require("../../AllCouriers/ShipxIndia/Courier/couriers.controller");
const {
  cancelOrderJiffy,
} = require("../../AllCouriers/Jiffy/Courier/couriers.controller");
const {
  removeFromPickupManifest,
} = require("../../Orders/scheduledPickup.controller");

const cancelOrdersAtBooked = async (req, res) => {
  try {
    const { awb_number } = req.params;
    if (!awb_number) {
      return res.status(400).json({
        success: false,
        message: "AWB number is required in params"
      });
    }

    const currentOrder = await Order.findOne({ awb_number });
    if (!currentOrder) {
      return res.status(404).json({
        success: false,
        message: `Order with AWB number ${awb_number} not found`
      });
    }

    if (["Cancelled", "new"].includes(currentOrder.status)) {
      return res.status(400).json({
        success: false,
        message: "Order is already cancelled"
      });
    }

    if (
      !["Ready To Ship", "Booked", "Not Picked"].includes(currentOrder.status)
    ) {
      return res.status(400).json({
        success: false,
        message: "Order is not ready to be cancelled"
      });
    }

    const userDoc = await user.findById(currentOrder.userId);
    if (!userDoc) {
      return res.status(404).json({
        success: false,
        message: "User linked with order not found"
      });
    }

    const currentWallet = await Wallet.findById(userDoc.Wallet).select("_id");
    if (!currentWallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet linked with user not found"
      });
    }

    let provider;
    if (
      currentOrder.partner === "ZipyPost" &&
      currentOrder.provider === "Bluedart"
    ) {
      provider = "ZipyPost";
    } else if (currentOrder.partner === "BoxdLogistics") {
      provider = "BoxdLogistics";
    } else if (currentOrder.partner === "Proship") {
      provider = "Proship";
    } else if (currentOrder.partner === "Losung360") {
      provider = "Losung360";
    } else if (currentOrder.partner === "Shadowfax" || currentOrder.provider === "Shadowfax") {
      provider = "Shadowfax";
    } else if (currentOrder.partner === "Shiprocket" || currentOrder.provider === "Shiprocket") {
      provider = "Shiprocket";
    } else if (currentOrder.partner === "ShipexIndia" || currentOrder.provider === "ShipexIndia") {
      provider = "ShipexIndia";
    } else if (currentOrder.partner === "Jiffy") {
      provider = "Jiffy";
    } else {
      provider = currentOrder.provider;
    }

    let result;
    switch (provider) {
      case "Delhivery":
        result = await cancelOrderDelhivery(currentOrder.awb_number);
        break;
      case "Dtdc":
        result = await cancelOrderDTDC(currentOrder.awb_number);
        break;
      case "Amazon Shipping":
        result = await cancelShipment(currentOrder.shipment_id);
        break;
      case "Smartship":
        result = await cancelSmartshipOrder(currentOrder.orderId);
        break;
      case "Shree Maruti":
        result = await cancelOrderShreeMaruti(currentOrder.orderId);
        break;
      case "ZipyPost":
        result = await cancelOrderZipypost(currentOrder.awb_number);
        break;
      case "Ekart":
        result = await cancelShipmentEkart(currentOrder.awb_number);
        break;
      case "BoxdLogistics":
        result = await cancelOrderBoxdLogistics(currentOrder.awb_number, currentOrder.orderId);
        break;
      case "Proship":
        result = await cancelProshipOrder(currentOrder.awb_number);
        break;
      case "Shadowfax":
        result = await cancelShadowfaxOrder(currentOrder.awb_number, currentOrder.courierName);
        break;
      case "Losung360":
        result = await cancelLosung360Order(currentOrder.awb_number);
        break;
      case "Shiprocket":
        result = await cancelShiprocketOrder(currentOrder.awb_number);
        break;
      case "ShipexIndia":
        result = await cancelShipexIndiaOrder(currentOrder.awb_number);
        break;
      case "Jiffy":
        result = await cancelOrderJiffy(currentOrder.awb_number);
        break;
      default:
        return res.status(400).json({
          success: false,
          message: "Unsupported courier provider"
        });
    }

    if (result?.error || result?.success === false) {
      return res.status(400).json({
        success: false,
        message:
          result.message || "Failed to cancel order with courier provider",
      });
    }

    // Remove from pickup manifest if exists
    try {
      await removeFromPickupManifest(currentOrder);
    } catch (err) {
      console.error("[Pickup] Failed to remove order from manifest during API cancellation:", err.message);
    }

    // Perform database updates inside a transaction with retry for write conflicts
    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Re-fetch within session to lock the document
        const currentOrderInSession = await Order.findById(currentOrder._id).session(session);
        currentOrderInSession.status = "Cancelled";
        currentOrderInSession.tracking.push({
          status: "Cancelled",
          StatusLocation: "",
          Instructions: "Cancelled order by user",
          StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        });
        await currentOrderInSession.save({ session });

        const balanceToBeAdded =
          currentOrderInSession.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(currentOrderInSession.totalFreightCharges);

        if (balanceToBeAdded > 0) {
          const walletInSession = await Wallet.findById(currentWallet._id)
            .select("balance")
            .session(session);

          const alreadyRefunded = await WalletTransaction.exists({
            walletId: currentWallet._id,
            awb_number: currentOrderInSession.awb_number,
            category: "credit",
            description: "Freight Charges Received",
          });

          if (!alreadyRefunded) {
            const newBalance = walletInSession.balance + balanceToBeAdded;

            // Sequential writes — never parallel inside a transaction (avoids WriteConflict)
            await Wallet.findOneAndUpdate(
              { _id: currentWallet._id },
              { $inc: { balance: balanceToBeAdded } },
              { session }
            );

            await WalletTransaction.create(
              [
                {
                  walletId: currentWallet._id,
                  channelOrderId: currentOrderInSession.orderId || null,
                  category: "credit",
                  amount: balanceToBeAdded,
                  balanceAfterTransaction: newBalance,
                  date: new Date(),
                  awb_number: currentOrderInSession.awb_number,
                  description: "Freight Charges Received",
                },
              ],
              { session }
            );
          }
        }

        await session.commitTransaction();
        session.endSession();

        return res.status(200).json({
          success: true,
          message: "Order cancelled successfully",
        });

      } catch (err) {
        await session.abortTransaction();
        session.endSession();

        // MongoDB TransientTransactionError: retry the whole transaction
        const isTransient =
          err.errorLabels?.includes("TransientTransactionError") ||
          err.code === 112;

        if (isTransient && attempt < MAX_RETRIES - 1) {
          attempt++;
          console.warn(`[CancelOrder] WriteConflict on attempt ${attempt}, retrying...`);
          await new Promise((r) => setTimeout(r, 100 * attempt)); // back-off: 100ms, 200ms
          continue;
        }

        throw err;
      }
    }
  } catch (error) {
    console.error("❌ Error cancelling order:", error);
    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
};

module.exports = cancelOrdersAtBooked;
