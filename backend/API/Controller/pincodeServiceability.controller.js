const Joi = require("joi");
const zoneManagementController = require("../../Rate/zoneManagementController");
const getZone = zoneManagementController.getZone;
const Plan = require("../../models/Plan.model");
const RateCard = require("../../models/rateCards");
const Couriers = require("../../models/AllCourierSchema.js");

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
  checkAmazonServiceabilityWithoutOrder,
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

// ✅ Input Validation Schema
const serviceabilitySchema = Joi.object({
  pickUpPincode: Joi.string()
    .trim()
    .required()
    .pattern(/^\d{6}$/),
  deliveryPincode: Joi.string()
    .trim()
    .required()
    .pattern(/^\d{6}$/),
  applicableWeight: Joi.number().positive().max(100).required(), // in kg
  length: Joi.number().positive().required(),
  width: Joi.number().positive().required(),
  height: Joi.number().positive().required(),
  paymentType: Joi.string().valid("COD", "Prepaid").required(),
  declaredValue: Joi.number().positive().allow(0).required(),
});

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
};

const pincodeServiceability = async (req, res) => {
  const { error, value: validated } = serviceabilitySchema.validate(req.body, {
    abortEarly: false,
  });

  if (error) {
    return res.status(400).json({
      status: "failure",
      message: "Invalid request data",
      errors: error.details.map((d) => {
        if (d.context.key.includes("Pincode")) {
          return "Pincode must be exactly 6 digits.";
        }
        return d.message;
      }),
    });
  }

  const {
    pickUpPincode,
    deliveryPincode,
    applicableWeight: actualWeight,
    length,
    width,
    height,
    paymentType,
    declaredValue,
  } = validated;

  try {
    const id = req.user._id;

    // ✅ Step 1: Calculate Volumetric Weight
    const volumetricWeight = (length * width * height) / 5000; // in kg
    const applicableWeight = Math.max(actualWeight, volumetricWeight);
    const chargedWeight = applicableWeight * 1000; // grams
    const order_type = paymentType === "COD" ? "cod" : "prepaid";
    const gst = 18;

    // ✅ Step 2: Get zone
    const result = await getZone(pickUpPincode, deliveryPincode);
    if (!result || !result.zone) {
      return res.status(400).json({
        status: "failure",
        message: "Could not determine zone for given pincodes.",
      });
    }
    const currentZone = result.zone;

    // ✅ Step 3: Get user plan
    const plan = await Plan.findOne({ userId: id });
    if (!plan || !plan.rateCard) {
      return res.status(500).json({
        status: "failure",
        message: "No rate cards available for this user.",
      });
    }
    const rateCards = plan.rateCard.filter(rc => rc.status === "Active");

    // ✅ Build isFlatRate lookup by _id — user-specific even if two users share plan name
    const rcIds = rateCards.map((r) => r._id).filter(Boolean);
    const rateCardDocs = await RateCard.find({ _id: { $in: rcIds } });
    const flatRateMap = new Map(
      rateCardDocs.map((doc) => [doc._id.toString(), doc.isFlatRate === true])
    );

    // ✅ Get enabled couriers from DB
    const activeCouriers = await Couriers.find({ status: "Enable" }).select(
      "courierProvider",
    );

    const activeCourierNames = activeCouriers.map((c) => c.courierProvider);

    // ✅ Step 4: Courier serviceability checks
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
        check: async () =>
          checkAmazonServiceabilityWithoutOrder(
            pickUpPincode,
            deliveryPincode,
            applicableWeight,
            declaredValue,
            paymentType,
            { length, width, height },
          ),
      },
      {
        name: "Shree Maruti",
        check: async () =>
          checkServiceabilityShreeMaruti({
            fromPincode: Number(pickUpPincode),
            toPincode: Number(deliveryPincode),
            isCodOrder: paymentType === "COD",
            deliveryMode: "SURFACE",
          }),
      },
      {
        name: "ZipyPost",
        check: async () =>
          checkZipypostServiceability({
            source_pincode: pickUpPincode,
            destination_pincode: deliveryPincode,
            payment_type: paymentType,
            order_weight: chargedWeight,
            length,
            breadth: width,
            height,
            order_value: declaredValue,
          }),
      },
      {
        name: "Ekart",
        isServiceSpecific: true,
        check: async (courierName) =>
          checkEkartServiceability({
            pickUpPincode,
            deliveryPincode,
            paymentMethod: paymentType,
            codAmount: declaredValue,
            courierName,
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
            weight: chargedWeight,
            length,
            breadth: width,
            height,
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
    ].filter((p) =>
      activeCourierNames.some(
        (name) => name.toLowerCase() === p.name.toLowerCase()
      )
    );

    const ans = [];
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

    const serviceabilityCache = {};
    for (const item of checkResults) {
      serviceabilityCache[item.serviceKey] = item.result;
    }

    // ✅ Step 5: Iterate through user’s rateCards
    for (let rc of rateCards) {
      if (rc.status !== "Active") continue;
      const provider = rc.courierProviderName;
      const providerCheck = providers.find((p) => p.name.toLowerCase() === provider.toLowerCase());
      if (!providerCheck) continue;

      const serviceKey = (providerCheck && providerCheck.isServiceSpecific)
        ? `${provider}_${rc.courierServiceName}`
        : provider;

      const serviceable = serviceabilityCache[serviceKey];
      // console.log("serviceable",serviceable)
      // console.log(`Serviceability for ${provider}:`, serviceable);
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

      if (!isServiceable) continue;

      // ✅ Charges calculation
      const basicCharge = parseFloat(rc.weightPriceBasic[0][currentZone]);
      const additionalCharge = parseFloat(
        rc.weightPriceAdditional[0][currentZone],
      );

      const count = Math.ceil(
        (chargedWeight - rc.weightPriceBasic[0].weight) /
        rc.weightPriceAdditional[0].weight,
      );
      const finalCharge =
        rc.weightPriceBasic[0].weight >= chargedWeight
          ? basicCharge
          : basicCharge + additionalCharge * count;

      // ✅ COD calculation
      // Use flag from object if present, otherwise fallback to lookup map
      const isFlatRate = rc.isFlatRate === true || flatRateMap.get(rc._id?.toString()) === true;
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

      // ✅ GST + Final total
      const gstAmount = Number(((finalCharge + cod) * gst) / 100).toFixed(2);
      const totalCharges = Math.round(
        finalCharge + cod + parseFloat(gstAmount),
      );

      ans.push({
        courierServiceName: rc.courierServiceName,
        courierId: courierIds[provider],
        codCharges: Number(cod.toFixed(2)),
        forward: {
          charges: Number(finalCharge.toFixed(2)),
          gst: Number(gstAmount),
          finalCharges: totalCharges,
        },
        applicableWeight: Number(applicableWeight.toFixed(2)),
        actualWeight: actualWeight,
        volumetricWeight: Number(volumetricWeight.toFixed(2)),
        serviceable: true,
      });
    }
    // console.log("ans", ans)
    // ✅ Step 6: Response
    if (ans.length === 0) {
      return res.status(200).json({
        status: "success",
        message: "No suitable courier service available for these pincodes.",
        data: [],
      });
    }

    return res.status(200).json({
      status: "success",
      message: "Rate calculation successful.",
      data: ans,
    });
  } catch (err) {
    console.error("Error in Serviceability Check:", err);
    return res.status(500).json({
      status: "failure",
      message: "An unexpected error occurred during serviceability check.",
      error: err.message,
    });
  }
};

module.exports = pincodeServiceability;
