const Joi = require("joi");
const zoneManagementController = require("../../Rate/zoneManagementController");
const getZone = zoneManagementController.getZone;
const Plan = require("../../models/Plan.model");
const RateCard = require("../../models/rateCards");
const Order = require("../../models/newOrder.model"); // ✅ import Order model
const CourierService = require("../../models/CourierService.Schema");
const {
  checkServiceabilityEcomExpress,
} = require("../../AllCouriers/EcomExpress/Couriers/couriers.controllers.js");
const {
  checkPincodeServiceabilityDelhivery,
} = require("../../AllCouriers/Delhivery/Courier/couriers.controller.js");
const {
  checkServiceabilityDTDC,
} = require("../../AllCouriers/DTDC/Courier/couriers.controller.js");
const {
  checkSmartshipHubServiceability,
} = require("../../AllCouriers/SmartShip/Couriers/couriers.controller.js");
const {
  checkAmazonServiceability,
} = require("../../AllCouriers/Amazon/Courier/couriers.controller.js");
const {
  checkServiceabilityShreeMaruti,
} = require("../../AllCouriers/ShreeMaruti/Couriers/couriers.controller.js");
const {
  checkZipypostServiceability,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller.js");
const {
  checkEkartServiceability,
} = require("../../AllCouriers/Ekart/Couriers/couriers.controller.js");
const {
  checkServiceabilityBoxdLogistics,
} = require("../../AllCouriers/BoxdLogistics/Courier/couriers.controller.js");
const {
  checkProshipServiceability,
} = require("../../AllCouriers/Proship/Courier/couriers.controller.js");
const {
  checkServiceabilityShipRocket,
} = require("../../AllCouriers/ShipRocket/Courier/couriers.controller.js");
const {
  checkPincodeServiceability: checkShadowfaxServiceability,
} = require("../../AllCouriers/Shadowfax/Courier/couriers.controller.js");
const {
  checkShipexIndiaServiceability,
} = require("../../AllCouriers/ShipxIndia/Courier/couriers.controller.js");

// Define courier IDs for each provider
const courierIds = {
  EcomExpress: "01",
  Delhivery: "02",
  Dtdc: "03",
  Smartship: "04",
  "Amazon Shipping": "05",
  "Shree Maruti": "06",
  ZipyPost: "07",
  Ekart: "08",
  BoxdLogistics: "09",
  Proship: "10",
  Shiprocket: "11",
  Shadowfax: "12",
  Losung360: "13",
  ShipexIndia: "14",
};

// Input Validation Schema
const serviceabilitySchema = Joi.object({
  orderId: Joi.string().trim().required(),
});

const availableCourierService = async (req, res) => {
  // 1. Validate orderId
  const { error, value } = serviceabilitySchema.validate(req.body, {
    abortEarly: false,
  });
  if (error) {
    return res.status(400).json({
      status: "failure",
      message: "Invalid request data",
      errors: error.details.map((d) => d.message),
    });
  }

  const { orderId } = value;

  try {
    const id = req.user._id;

    // Fetch Order and Plan in parallel to optimize response time
    const [order, plan] = await Promise.all([
      Order.findOne({ orderId }),
      Plan.findOne({ userId: id }),
    ]);

    if (!order) {
      return res.status(404).json({
        status: "failure",
        message: "Order not found.",
      });
    }

    if (!plan || !plan.rateCard) {
      return res.status(500).json({
        status: "failure",
        message: "No rate cards available for this user.",
      });
    }

    // ✅ Extract required fields from DB order
    const pickUpPincode = order.pickupAddress.pinCode;
    const deliveryPincode = order.receiverAddress.pinCode;
    const applicableWeight = order.packageDetails.applicableWeight;
    const paymentType = order.paymentDetails.method; // "COD" or "Prepaid"
    const declaredValue = order.paymentDetails.amount;

    const rateCards = plan.rateCard;
    const rcIds = rateCards.map((r) => r._id).filter(Boolean);

    // Fetch Zone and RateCard documents in parallel to optimize response time
    const [zoneResult, rateCardDocs] = await Promise.all([
      getZone(pickUpPincode, deliveryPincode),
      RateCard.find({ _id: { $in: rcIds } }),
    ]);

    if (!zoneResult || !zoneResult.zone) {
      return res.status(400).json({
        status: "failure",
        message: "Could not determine zone for given pincodes.",
      });
    }
    const currentZone = zoneResult.zone;

    const order_type = paymentType === "COD" ? "cod" : "prepaid";
    const chargedWeight = applicableWeight * 1000; // grams
    const gst = 18;
    const ans = [];
    const serviceabilityCache = {};

    // ✅ Build isFlatRate lookup by _id — user-specific even if two users share plan name
    const flatRateMap = new Map(
      rateCardDocs.map((doc) => [doc._id.toString(), doc.isFlatRate === true])
    );

    const shipexServices = await CourierService.find({ provider: "ShipexIndia" }).lean();
    const shipexServiceMap = new Map(
      shipexServices.map((s) => [s.name.toLowerCase().trim(), s.courier || s.name])
    );

    const providers = [
      {
        name: "EcomExpress",
        check: async () =>
          checkServiceabilityEcomExpress(pickUpPincode, deliveryPincode),
      },
      {
        name: "Delhivery",
        check: async () =>
          checkPincodeServiceabilityDelhivery(
            pickUpPincode,
            deliveryPincode,
            order_type,
          ),
      },
      {
        name: "Dtdc",
        check: async () =>
          checkServiceabilityDTDC(pickUpPincode, deliveryPincode, paymentType),
      },
      {
        name: "Smartship",
        check: async () =>
          checkSmartshipHubServiceability({
            source_pincode: pickUpPincode,
            destination_pincode: deliveryPincode,
            order_weight: applicableWeight,
            order_value: declaredValue,
          }),
      },
      {
        name: "Amazon Shipping",
        check: async () => {
          const weight = order.packageDetails?.applicableWeight * 1000;
          const payload = {
            origin: order.pickupAddress,
            destination: order.receiverAddress,
            payment_type: order.paymentDetails?.method,
            order_amount: order.paymentDetails?.amount || 0,
            weight: weight || 0,
            length: order.packageDetails.volumetricWeight?.length || 0,
            breadth: order.packageDetails.volumetricWeight?.width || 0,
            height: order.packageDetails.volumetricWeight?.height || 0,
            productDetails: order.productDetails,
            orderId: order.orderId,
          };
          const { rate, requestToken } = await checkAmazonServiceability("Amazon", payload);
          return (rate && requestToken) ? { success: true } : { success: false };
        },
      },
      {
        name: "Shree Maruti",
        check: async () =>
          checkServiceabilityShreeMaruti({
            fromPincode: parseInt(pickUpPincode),
            toPincode: parseInt(deliveryPincode),
            isCodOrder: order.paymentDetails.method === "COD",
            deliveryMode: "SURFACE",
          }),
      },
      {
        name: "ZipyPost",
        check: async () =>
          checkZipypostServiceability({
            source_pincode: pickUpPincode,
            destination_pincode: deliveryPincode,
            payment_type: order.paymentDetails?.method,
            order_weight: order.packageDetails?.applicableWeight * 1000,
            length: order.packageDetails.volumetricWeight?.length || 0,
            breadth: order.packageDetails.volumetricWeight?.width || 0,
            height: order.packageDetails.volumetricWeight?.height || 0,
            order_value: order.paymentDetails?.amount || 0,
          }),
      },
      {
        name: "Ekart",
        isServiceSpecific: true,
        check: async (serviceName) =>
          checkEkartServiceability({
            pickUpPincode,
            deliveryPincode,
            paymentMethod: paymentType,
            codAmount: declaredValue,
            courierName: serviceName,
          }),
      },
      {
        name: "BoxdLogistics",
        check: async () =>
          checkServiceabilityBoxdLogistics({
            pickupPincode: pickUpPincode,
            shippingPincode: deliveryPincode,
            paymentMode: paymentType === "COD" ? "cod" : "prepaid",
            codAmount: paymentType === "COD" ? declaredValue : 0,
            weight: applicableWeight * 1000,
            length: 10,
            breadth: 10,
            height: 10,
          }),
      },
      {
        name: "Proship",
        check: async () =>
          checkProshipServiceability({
            pickUpPincode: pickUpPincode,
            deliveryPincode: deliveryPincode,
          }),
      },
      {
        name: "Shiprocket",
        isServiceSpecific: true,
        check: async (serviceName) =>
          checkServiceabilityShipRocket({
            serviceName,
            origin: pickUpPincode,
            destination: deliveryPincode,
            payment_type: paymentType === "COD",
            weight: applicableWeight,
          }),
      },
      {
        name: "Shadowfax",
        check: async () =>
          checkShadowfaxServiceability(deliveryPincode),
      },
      {
        name: "Losung360",
        check: async () => ({ success: true }),
      },
      {
        name: "ShipexIndia",
        check: async () =>
          checkShipexIndiaServiceability({
            pickUpPincode,
            deliveryPincode,
            applicableWeight,
            paymentType,
            declaredValue,
            length: order.packageDetails?.volumetricWeight?.length || 10,
            width: order.packageDetails?.volumetricWeight?.width || 10,
            height: order.packageDetails?.volumetricWeight?.height || 10,
          }),
      },
    ];

    const uniqueChecks = [];
    const checkKeys = new Set();

    for (let rc of rateCards) {
      if (rc.status !== "Active") continue;
      const provider = rc.courierProviderName;
      const providerCheck = providers.find((p) => p.name.toLowerCase() === provider.toLowerCase());
      if (!providerCheck) continue;

      const serviceKey = providerCheck.isServiceSpecific
        ? `${provider}_${rc.courierServiceName}`
        : provider;

      if (!checkKeys.has(serviceKey)) {
        checkKeys.add(serviceKey);
        uniqueChecks.push({
          provider,
          serviceName: rc.courierServiceName,
          serviceKey,
          checkFn: providerCheck.check,
        });
      }
    }

    // Execute all serviceability checks in parallel
    const checkResults = await Promise.all(
      uniqueChecks.map(async (item) => {
        try {
          const result = await item.checkFn(item.serviceName);
          return { serviceKey: item.serviceKey, result };
        } catch (err) {
          console.error(`Serviceability check failed for ${item.serviceKey}:`, err);
          return { serviceKey: item.serviceKey, result: { success: false, error: err.message } };
        }
      })
    );

    for (const item of checkResults) {
      serviceabilityCache[item.serviceKey] = item.result;
    }

    // 5. Loop through rateCards & calculate serviceability + charges
    for (let rc of rateCards) {
      if (rc.status !== "Active") continue;
      const provider = rc.courierProviderName;
      if (!Object.keys(courierIds).includes(provider)) continue;

      const providerCheck = providers.find((p) => p.name.toLowerCase() === provider.toLowerCase());
      const serviceKey = (providerCheck && providerCheck.isServiceSpecific)
        ? `${provider}_${rc.courierServiceName}`
        : provider;

      const serviceable = serviceabilityCache[serviceKey];
      let isServiceable = serviceable && serviceable.success !== false;

      if (provider.toLowerCase() === "boxdlogistics" && isServiceable && Array.isArray(serviceable.courier_ids)) {
        const sName = rc.courierServiceName.toLowerCase();
        if (sName.includes("flat")) {
          isServiceable = serviceable.courier_ids.includes(7);
        } else if (sName.includes("surface")) {
          isServiceable = serviceable.courier_ids.includes(4);
        } else if (sName.includes("air")) {
          isServiceable = serviceable.courier_ids.includes(6);
        }
      }

      if (provider.toLowerCase() === "proship" && isServiceable && serviceable.couriers) {
        const sName = rc.courierServiceName.toLowerCase();
        if (sName.includes("shadowfax")) {
          isServiceable = !!serviceable.couriers.shadowfax;
        } else if (sName.includes("dtdc")) {
          isServiceable = !!serviceable.couriers.dtdc;
        }
      }

      if (provider.toLowerCase() === "shipexindia" && isServiceable) {
        let isCourierServiceable = false;
        if (Array.isArray(serviceable.data)) {
          const mappedName =
            shipexServiceMap.get(rc.courierServiceName.toLowerCase().trim()) ||
            rc.courierServiceName;
          const matchedCourier = serviceable.data.find(
            (item) =>
              item.courierServiceName &&
              item.courierServiceName.toLowerCase().replace(/\s+/g, "") ===
                mappedName.toLowerCase().replace(/\s+/g, "")
          );
          if (matchedCourier && matchedCourier.serviceable === true) {
            isCourierServiceable = true;
          }
        }
        isServiceable = isCourierServiceable;
      }

      if (!isServiceable) continue;

      // ✅ Charges calculation
      let basicCharge = parseFloat(rc.weightPriceBasic[0][currentZone]);
      let additionalCharge = parseFloat(
        rc.weightPriceAdditional[0][currentZone],
      );
      const count = Math.ceil(
        (chargedWeight - rc.weightPriceBasic[0].weight) /
        rc.weightPriceAdditional[0].weight,
      );
      let finalCharge =
        rc.weightPriceBasic[0].weight >= chargedWeight
          ? basicCharge
          : basicCharge + additionalCharge * count;

      // COD calculation
      const isFlatRate = flatRateMap.get(rc._id?.toString()) || false;
      let cod = 0;
      if (paymentType === "COD" && !isFlatRate) {
        const orderValue = Number(declaredValue) || 0;
        if (
          typeof rc.codCharge === "number" &&
          typeof rc.codPercent === "number"
        ) {
          cod = Math.max(rc.codCharge, orderValue * (rc.codPercent / 100));
        }
      }

      // GST + Final Total
      let gstAmount = Number(((finalCharge + cod) * gst) / 100).toFixed(2);
      let totalCharges = Math.round(finalCharge + cod + parseFloat(gstAmount));

      ans.push({
        courierServiceName: rc.courierServiceName,
        courierId: courierIds[provider],
        codCharges: Number(cod.toFixed(2)),
        forward: {
          charges: Number(finalCharge.toFixed(2)),
          gst: Number(gstAmount),
          finalCharges: totalCharges,
        },
        serviceable: true,
      });
    }

    // ✅ Response
    if (ans.length === 0) {
      return res.status(200).json({
        status: "success",
        message: "No suitable service providers available for this order.",
        data: [],
      });
    }

    return res.status(200).json({
      status: "success",
      message: "Rate calculation successful.",
      data: ans,
    });
  } catch (err) {
    console.error("Error in Public Rate Calculation:", err);
    return res.status(500).json({
      status: "failure",
      message: "An unexpected error occurred during rate calculation.",
      error: err.message,
    });
  }
};

module.exports = availableCourierService;
