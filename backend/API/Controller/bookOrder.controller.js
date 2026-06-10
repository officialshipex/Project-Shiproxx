const Joi = require("joi");
const {
  checkServiceabilityAll,
} = require("../../Orders/shipment.controller");
const {
  calculateRateForService,
} = require("../../Rate/calculateRateController");
const Order = require("../../models/newOrder.model");
const Wallet = require("../../models/wallet");
const createAmazonShipment = require("../Courier/amazonShipmentCreation.controller");
const createDelhiveryShipment = require("../Courier/delhiveryShipmentCreation.controller");
const createDTDCShipment = require("../Courier/dtdcShipmentCreation.controller");
const createSmartshipShipment = require("../Courier/smartshipShipmentCreation.controller");
const CourierService = require("../../models/CourierService.Schema");
const User = require("../../models/User.model");
const createShreeMarutiShipment = require("../Courier/shreeMarutiShipmentCreation.controller");
const createZipypostShipment = require("../Courier/zipyPostShipmentCreation.controller");
const createEkartShipment = require("../Courier/ekartShipmentCreation.controller");
const createBoxdLogisticsShipment = require("../Courier/boxdLogisticsShipmentCreation.controller");
const createProshipShipment = require("../Courier/proshipShipmentCreation.controller");
const createShiprocketShipment = require("../Courier/shiprocketShipmentCreation.controller");
const createShadowfaxShipment = require("../Courier/shadowfaxShipmentCreation.controller");
const createLosung360Shipment = require("../Courier/losung360ShipmentCreation.controller");

// Provider mapping
const providerMap = {
  // "01": "EcomExpress",
  "02": "Delhivery",
  "03": "Dtdc",
  "04": "Smartship",
  "05": "Amazon Shipping",
  "06": "Shree Maruti",
  "07": "ZipyPost",
  "08": "Ekart",
  "09": "BoxdLogistics",
  "10": "Proship",
  "11": "Shiprocket",
  "12": "Shadowfax",
  "13": "Losung360",
};

// Validation schema
const orderSchema = Joi.object({
  orderId: Joi.string().trim().required().messages({
    "string.empty": "Order ID is required",
  }),
  courierServiceName: Joi.string().trim().required().messages({
    "string.empty": "Courier Service Name is required",
  }),
  courierId: Joi.string().length(2).required().messages({
    "string.length": "Courier ID must be a 2-digit string",
    "string.empty": "Courier ID is required",
  }),
});

const bookOrder = async (req, res) => {
  const userId = req.user._id;

  // ✅ Validate request body
  const { error, value } = orderSchema.validate(req.body, {
    abortEarly: false,
  });
  if (error) {
    return res.status(400).json({
      status: "failure",
      message: "Invalid request data",
      errors: error.details.map((d) => d.message),
    });
  }

  const { orderId, courierServiceName, courierId } = value;
  const provider = providerMap[courierId] || null;

  try {
    // ✅ Fetch order, user in parallel (fast DB reads)
    const [order, user] = await Promise.all([
      Order.findOne({ orderId, userId }),
      User.findById(userId),
    ]);

    if (!order) {
      return res.status(404).json({
        status: "failure",
        message: `Order with ID ${orderId} not found.`,
      });
    }

    if (order.status !== "new") {
      return res.status(400).json({
        status: "failure",
        message: "Order must be in 'new' state to book shipment.",
      });
    }

    if (!user) {
      return res.status(404).json({
        status: "failure",
        message: "User not found.",
      });
    }

    if (!user.kycDone) {
      return res.status(403).json({
        status: "failure",
        message:
          "KYC not completed. Please verify your KYC before booking an order.",
      });
    }

    // ✅ Fetch wallet + courier service in parallel
    const [wallet, courierService] = await Promise.all([
      // ✅ PERF FIX: Only load balance fields — excludes massive transactions/history arrays
      // Without .select(), a user with 2000 orders loads ~2MB of transaction data
      Wallet.findById(user.Wallet).select("balance holdAmount creditLimit"),
      // ✅ Exact match — no $regex, uses compound index (name, provider)
      CourierService.findOne({
        name: courierServiceName.trim(),
        provider,
      }),
    ]);

    if (!wallet) {
      return res.status(404).json({
        status: "failure",
        message: "Wallet not found for user.",
      });
    }

    if (!provider) {
      return res.status(400).json({
        status: "failure",
        message: `Courier ID '${courierId}' is invalid or not supported.`,
      });
    }

    if (!courierService) {
      return res.status(400).json({
        status: "failure",
        message: `Courier service '${courierServiceName}' and courier ID '${courierId}' mismatch or not supported.`,
      });
    }

    if (courierService.status === "Disable") {
      return res.status(400).json({
        status: "failure",
        message: `Courier service '${courierServiceName}' is currently disabled.`,
      });
    }

    // ✅ Check serviceability
    const serviceability = await checkServiceabilityAll(
      {
        provider,
        courier: courierService.courier,
        name: courierService.name,
      },
      order._id,
      order.pickupAddress?.pinCode
    );

    const isServiceable = serviceability && (serviceability.success === true || serviceability === true);

    if (!isServiceable) {
      return res.status(400).json({
        status: "failure",
        message: `This destination pincode is not serviceable by ${courierServiceName}.`,
      });
    }

    // ✅ Prepare payload for rate calculation
    const payload = {
      pickupPincode: order.pickupAddress?.pinCode,
      deliveryPincode: order.receiverAddress?.pinCode,
      length: order.packageDetails?.volumetricWeight?.length,
      breadth: order.packageDetails?.volumetricWeight?.breadth,
      height: order.packageDetails?.volumetricWeight?.height,
      weight: order.packageDetails?.applicableWeight,
      cod: order.paymentDetails?.method === "COD" ? "Yes" : "No",
      valueInINR: order.paymentDetails?.amount,
      userID: userId,
    };

    // ✅ Calculate rates (pure DB math — no external API calls)
    const finalChargesArray = await calculateRateForService(payload);

    // ✅ Validate courier service rate
    const matchedChargeObj = finalChargesArray.find(
      (item) =>
        item.courierServiceName.toLowerCase().trim() ===
        courierServiceName.toLowerCase().trim(),
    );

    if (!matchedChargeObj) {
      return res.status(400).json({
        status: "failure",
        message: `Courier service '${courierServiceName}' is invalid or not supported.`,
      });
    }

    const finalCharges = matchedChargeObj.forward?.finalCharges || null;
    if (!finalCharges) {
      return res.status(400).json({
        status: "failure",
        message: `Rate for courier service '${courierServiceName}' not available.`,
      });
    }

    const priceBreakup = {
      freight: matchedChargeObj?.forward?.charges,
      cod: matchedChargeObj?.cod,
      gst: matchedChargeObj?.forward?.gst,
      total: matchedChargeObj?.forward?.finalCharges,
    };

    // ✅ Check wallet balance
    const walletHoldAmount = wallet.holdAmount || 0;
    const effectiveBalance = wallet.balance - walletHoldAmount;
    const totalAvailableBalance = effectiveBalance + (wallet.creditLimit || 0);

    if (totalAvailableBalance < finalCharges) {
      return res.status(400).json({
        status: "failure",
        message: "Insufficient wallet balance to create this shipment.",
      });
    }

    // ✅ Create shipment by provider
    let shipmentResult;
    switch (provider) {
      case "Amazon Shipping":
        shipmentResult = await createAmazonShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "Delhivery":
        shipmentResult = await createDelhiveryShipment({
          id: order._id,
          provider: courierService.courierName || provider,
          courierName: courierService.courierName || "Delhivery",
          finalCharges,
          courierServiceName,
          priceBreakup,
          // ✅ PERF FIX: Pass pre-fetched data to avoid redundant User/Wallet/Plan loading
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "Dtdc":
        shipmentResult = await createDTDCShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          courier: courierService?.courier,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "Smartship":
        shipmentResult = await createSmartshipShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "Shree Maruti":
        shipmentResult = await createShreeMarutiShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "ZipyPost":
        shipmentResult = await createZipypostShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "Ekart":
        shipmentResult = await createEkartShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "BoxdLogistics":
        shipmentResult = await createBoxdLogisticsShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          courier: courierService?.courier,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;
      case "Proship":
        shipmentResult = await createProshipShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;

      case "Shiprocket":
        shipmentResult = await createShiprocketShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;

      case "Shadowfax":
        shipmentResult = await createShadowfaxShipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;

      case "Losung360":
        shipmentResult = await createLosung360Shipment({
          id: order._id,
          provider,
          finalCharges,
          courierServiceName,
          partnerServiceId: courierService.courier_id,
          priceBreakup,
          userId: userId,
          walletId: user.Wallet,
          walletBalance: wallet.balance,
          walletHoldAmount: wallet.holdAmount || 0,
          walletCreditLimit: wallet.creditLimit || 0,
        });
        break;

      case "EcomExpress":
        return res.status(400).json({
          status: "failure",
          message: "EcomExpress shipment creation not implemented yet.",
        });

      default:
        return res.status(400).json({
          status: "failure",
          message: `Courier ID '${courierId}' is mismatched or not supported.`,
        });
    }

    if (!shipmentResult?.success) {
      console.error("Shipment creation failed:", shipmentResult);
      return res.status(400).json({
        status: "failure",
        message: shipmentResult?.message || "Shipment creation failed.",
      });
    }

    // ✅ Final success response
    return res.status(200).json({
      status: "success",
      message: "Order booked and shipment created successfully.",
      data: {
        orderId,
        courierServiceName,
        courierId,
        awb_number: shipmentResult.awb_number || null,
        labelUrl: shipmentResult.labelUrl || null,
      },
    });
  } catch (err) {
    console.error("Error booking order:", err);
    return res.status(500).json({
      status: "failure",
      message: "Unexpected server error while booking order. Please try again.",
    });
  }
};

module.exports = bookOrder;
