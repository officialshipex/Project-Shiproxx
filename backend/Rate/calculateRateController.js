const RateCard = require("../models/rateCards.js");
const zoneManagementController = require("./zoneManagementController.js");
const getZone = zoneManagementController.getZone;
const Plan = require("../models/Plan.model.js");
const Couriers = require("../models/AllCourierSchema.js");
const {
  checkServiceabilityEcomExpress,
} = require("../AllCouriers/EcomExpress/Couriers/couriers.controllers.js");
const {
  checkPincodeServiceabilityDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller.js");
const {
  checkServiceabilityDTDC,
} = require("../AllCouriers/DTDC/Courier/couriers.controller.js");
const {
  checkSmartshipHubServiceability,
} = require("../AllCouriers/SmartShip/Couriers/couriers.controller.js");
const {
  checkAmazonServiceabilityWithoutOrder,
} = require("../AllCouriers/Amazon/Courier/couriers.controller.js");
const {
  checkServiceabilityShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/couriers.controller.js");
const {
  checkPincodeServiceability,
} = require("../checkPincodeServiceability/checkPincodeServiceability.controller.js");
const {
  checkZipypostServiceability,
} = require("../AllCouriers/Zipypost/Couriers/couriers.controller.js");
const { checkEkartServiceability } = require("../AllCouriers/Ekart/Couriers/couriers.controller.js");
const { checkServiceabilityBoxdLogistics } = require("../AllCouriers/BoxdLogistics/Courier/couriers.controller.js");
const { checkProshipServiceability } = require("../AllCouriers/Proship/Courier/couriers.controller.js");
const { checkServiceabilityShipRocket } = require("../AllCouriers/ShipRocket/Courier/couriers.controller.js");
const { checkShipexIndiaServiceability } = require("../AllCouriers/ShipxIndia/Courier/couriers.controller.js");


const calculateRate = async (req, res) => {
  try {
    const id = req.user._id;
    const {
      pickUpPincode,
      deliveryPincode,
      applicableWeight,
      paymentType,
      declaredValue,
      dimensions,
    } = req.body;

    console.log(
      pickUpPincode,
      deliveryPincode,
      applicableWeight,
      paymentType,
      declaredValue,
      dimensions,
    );

    // Step 1: Get user’s plan
    const plan = await Plan.findOne({ userId: id });
    if (!plan) return res.status(404).json({ message: "Plan not found" });
    // ✅ Get active couriers from DB
    const activeCouriers = await Couriers.find({ status: "Enable" }).select(
      "courierName",
    );

    const activeCourierNames = activeCouriers.map((c) => c.courierName);
    // console.log("activeCourierNames:", activeCourierNames);

    const rateCards = plan.rateCard;
    const orderType = paymentType === "COD" ? "cod" : "prepaid";

    // Step 2: Get zone
    const { zone: currentZone } = await getZone(pickUpPincode, deliveryPincode);
    const chargedWeight = applicableWeight * 1000;
    const gst = 18;
    const ans = [];
    const serviceabilityCache = {};

    // ✅ Build isFlatRate lookup by _id — user-specific even if two users share plan name
    const rcIds = rateCards.map((r) => r._id).filter(Boolean);
    const rateCardDocs = await RateCard.find({ _id: { $in: rcIds } });
    const flatRateMap = new Map(
      rateCardDocs.map((doc) => [doc._id.toString(), doc.isFlatRate === true])
    );

    // Fetch ShipexIndia courier services mapping for O(1) matching in loop
    const CourierService = require("../models/CourierService.Schema");
    const shipexServices = await CourierService.find({ provider: "ShipexIndia" }).lean();
    const shipexServiceMap = new Map(
      shipexServices.map(s => [s.name.toLowerCase().trim(), s.courier || s.name])
    );

    // Fetch Jiffy courier services mapping (RateCard.courierServiceName -> the
    // Jiffy courier_code stored in CourierService.courier) for O(1) matching.
    const {
      checkServiceabilityJiffy,
    } = require("../AllCouriers/Jiffy/Courier/couriers.controller");
    const jiffyServices = await CourierService.find({ provider: "Jiffy" }).lean();
    const jiffyServiceMap = new Map(
      jiffyServices.map(s => [s.name.toLowerCase().trim(), s.courier])
    );

    for (let rc of rateCards) {
      // Use flag from object if present, otherwise fallback to lookup map (for legacy/sync cases)
      const isFlatRate = rc.isFlatRate === true || flatRateMap.get(rc._id?.toString()) === true;
      const provider = rc.courierProviderName;
      const mode = rc.mode;
      let serviceable = { success: false };

      const activeCouriersLower = activeCourierNames.map(c => c.toLowerCase());
      if (!activeCouriersLower.includes(provider.toLowerCase())) continue;
      if (rc.status !== "Active") continue;

      if (!["Delhivery", "Shree Maruti", "Dtdc", "Smartship", "Amazon Shipping", "EcomExpress", "Zipypost", "Ekart", "BoxdLogistics", "Proship", "Shiprocket", "ShipexIndia", "Jiffy"].includes(provider)) continue;

      if (provider === "Jiffy") {
        if (!serviceabilityCache[provider]) {
          const payload = {
            pickupPincode: pickUpPincode,
            deliveryPincode,
            rtoPincode: pickUpPincode,
            paymentMode: paymentType === "COD" ? "cod" : "prepaid",
            collectableAmount: paymentType === "COD" ? declaredValue : 0,
            weight: applicableWeight,
            length: dimensions?.length || 10,
            breadth: dimensions?.width || 10,
            height: dimensions?.height || 10,
          };
          serviceabilityCache[provider] = await checkServiceabilityJiffy(payload);
        }
        const jiffyResult = serviceabilityCache[provider];
        if (!jiffyResult || jiffyResult.success === false) continue;

        // Match on Jiffy's own `code` (same value stored in CourierService.courier
        // and sent as courier_code when booking) — not the display name.
        let isServiceable = false;
        const targetCode = jiffyServiceMap.get(rc.courierServiceName.toLowerCase().trim());
        if (targetCode && Array.isArray(jiffyResult.data)) {
          const matchedCourier = jiffyResult.data.find(
            (item) => item.code && item.code.toUpperCase() === targetCode.toUpperCase()
          );
          const paymentKey = paymentType === "COD" ? "cod" : "prepaid";
          if (matchedCourier && matchedCourier.is_active && matchedCourier.services?.[paymentKey]) {
            isServiceable = true;
          }
        }
        if (!isServiceable) continue;
        serviceable = { success: true };
      } else if (provider === "ShipexIndia") {
        if (!serviceabilityCache[provider]) {
          const payload = {
            pickUpPincode,
            deliveryPincode,
            applicableWeight,
            length: dimensions?.length || 10,
            width: dimensions?.width || 10,
            height: dimensions?.height || 10,
            paymentType,
            declaredValue,
          };
          serviceabilityCache[provider] = await checkShipexIndiaServiceability(payload);
        }
        const shipexResult = serviceabilityCache[provider];
        if (!shipexResult || shipexResult.success === false) continue;

        let isServiceable = false;
        if (Array.isArray(shipexResult.data)) {
          const mappedName = shipexServiceMap.get(rc.courierServiceName.toLowerCase().trim()) || rc.courierServiceName;
          const matchedCourier = shipexResult.data.find(
            (item) =>
              item.courierServiceName &&
              item.courierServiceName.toLowerCase().replace(/\s+/g, "") ===
                mappedName.toLowerCase().replace(/\s+/g, "")
          );
          if (matchedCourier && matchedCourier.serviceable === true) {
            isServiceable = true;
          }
        }
        if (!isServiceable) continue;
        serviceable = { success: true };
      } else if (provider === "BoxdLogistics") {

        if (!serviceabilityCache[provider]) {
          const payload = {
            pickupPincode: pickUpPincode,
            shippingPincode: deliveryPincode,
            paymentMode: paymentType === "COD" ? "cod" : "prepaid",
            codAmount: paymentType === "COD" ? declaredValue : 0,
            weight: chargedWeight,
            length: dimensions?.length || 10,
            breadth: dimensions?.width || 10,
            height: dimensions?.height || 10,
          };
          serviceabilityCache[provider] = await checkServiceabilityBoxdLogistics(payload);
        }
        const boxdResult = serviceabilityCache[provider];
        let boxdServiceable = boxdResult && boxdResult.success !== false;
        if (boxdServiceable && Array.isArray(boxdResult.courier_ids)) {
          const sName = rc.courierServiceName.toLowerCase();
          if (sName.includes("flat")) {
            boxdServiceable = boxdResult.courier_ids.includes(7);
          } else if (sName.includes("surface")) {
            boxdServiceable = boxdResult.courier_ids.includes(4);
          } else if (sName.includes("air")) {
            boxdServiceable = boxdResult.courier_ids.includes(6);
          }
        }
        if (!boxdServiceable) continue;
        serviceable = { success: true };
      } else if (provider === "Proship") {
        if (!serviceabilityCache[provider]) {
          const payload = { pickUpPincode, deliveryPincode };
          serviceabilityCache[provider] = await checkProshipServiceability(payload);
        }
        const proshipResult = serviceabilityCache[provider];
        if (!proshipResult || proshipResult.success === false) continue;
        let proshipServiceable = true;
        if (proshipResult.couriers) {
          const sName = rc.courierServiceName.toLowerCase();
          if (sName.includes("shadowfax")) {
            proshipServiceable = !!proshipResult.couriers.shadowfax;
          } else if (sName.includes("dtdc")) {
            proshipServiceable = !!proshipResult.couriers.dtdc;
          }
        }
        if (!proshipServiceable) continue;
        serviceable = { success: true };
      } else if (provider === "Shiprocket") {
        const sName = rc.courierServiceName;
        const cacheKey = `${provider}_${sName}`;
        if (!serviceabilityCache[cacheKey]) {
          const payload = {
            serviceName: sName,
            origin: pickUpPincode,
            destination: deliveryPincode,
            payment_type: paymentType === "COD",
            weight: applicableWeight,
          };
          serviceabilityCache[cacheKey] = await checkServiceabilityShipRocket(payload);
        }
        if (!serviceabilityCache[cacheKey]?.success) continue;
        serviceable = { success: true };
      } else {
        if (!serviceabilityCache[provider]) {
          serviceabilityCache[provider] = {
            local: await checkPincodeServiceability(pickUpPincode, provider, deliveryPincode, paymentType)
          };
        }
        let localServiceability = serviceabilityCache[provider].local;

        if (localServiceability.success === true) {
          serviceable = { success: true };
        } else if (["courier_not_found", "error", "pincode_not_found"].includes(localServiceability.reason)) {
          if (!serviceabilityCache[provider].api) {
            if (provider === "EcomExpress") {
              serviceabilityCache[provider].api = await checkServiceabilityEcomExpress(pickUpPincode, deliveryPincode);
            } else if (provider === "Shree Maruti") {
              serviceabilityCache[provider].api = await checkServiceabilityShreeMaruti({
                fromPincode: parseInt(pickUpPincode),
                toPincode: parseInt(deliveryPincode),
                isCodOrder: paymentType === "COD",
                deliveryMode: "SURFACE",
              });
            } else if (provider === "Delhivery") {
              serviceabilityCache[provider].api = await checkPincodeServiceabilityDelhivery(pickUpPincode, deliveryPincode, orderType);
            } else if (provider === "Dtdc") {
              serviceabilityCache[provider].api = await checkServiceabilityDTDC(pickUpPincode, deliveryPincode, paymentType);
            } else if (provider === "Smartship") {
              serviceabilityCache[provider].api = await checkSmartshipHubServiceability({
                source_pincode: pickUpPincode,
                destination_pincode: deliveryPincode,
                order_weight: applicableWeight,
                order_value: declaredValue,
              });
            } else if (provider === "Amazon Shipping") {
              serviceabilityCache[provider].api = await checkAmazonServiceabilityWithoutOrder(pickUpPincode, deliveryPincode, applicableWeight, declaredValue, paymentType, dimensions);
            } else if (provider === "Zipypost") {
              serviceabilityCache[provider].api = await checkZipypostServiceability({
                source_pincode: pickUpPincode,
                destination_pincode: deliveryPincode,
                payment_type: paymentType,
                order_value: declaredValue,
                length: dimensions.length,
                width: dimensions.width,
                height: dimensions.height,
                order_weight: applicableWeight,
              });
            } else if (provider === "Ekart") {
              serviceabilityCache[provider].api = await checkEkartServiceability({ pickUpPincode, deliveryPincode, paymentMethod: paymentType, codAmount: declaredValue });
            }
          }
          serviceable = serviceabilityCache[provider].api;
        } else {
          continue;
        }
      }

      let isServiceable = serviceable && serviceable.success !== false;

      if (!isServiceable) continue;

      // Step 5: Rate calculation
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

      const isFlat = isFlatRate;
      // Step 6: COD charges
      let cod = 0;
      if (paymentType === "COD" && !isFlat) {
        const orderValue = Number(declaredValue) || 0;
        if (
          typeof rc.codCharge === "number" &&
          typeof rc.codPercent === "number"
        ) {
          cod = Math.max(rc.codCharge, orderValue * (rc.codPercent / 100));
        }
      }

      // Step 7: GST and total
      let gstAmount = Number(((finalCharge + cod) * gst) / 100).toFixed(2);

      let totalCharges = Math.round(finalCharge + cod + parseFloat(gstAmount));

      ans.push({
        courierServiceName: rc.courierServiceName,
        orderType: "B2C",
        provider,
        mode,
        cod,
        forward: {
          charges: finalCharge,
          gst: gstAmount,
          finalCharges: totalCharges,
        },
      });
    }

    return res.status(201).json(ans);
  } catch (error) {
    console.error("Error in Calculation:", error);
    res.status(500).json({ error: "Error in Calculation" });
  }
};

async function calculateRateForService(payload) {
  try {
    const {
      pickupPincode,
      deliveryPincode,
      length,
      breadth,
      height,
      weight,
      cod,
      valueInINR,
      userID,
      filteredServices,
      // rateCardType,
    } = payload;

    // ✅ PERF FIX: Parallel fetch zone + plan (saves ~100-200ms vs sequential)
    const [zoneResult, plan] = await Promise.all([
      getZone(pickupPincode, deliveryPincode),
      Plan.findOne({ userId: userID }).lean(),
    ]);

    const currentZone = zoneResult?.zone;

    const ans = [];
    const l = parseFloat(length);
    const b = parseFloat(breadth);
    const h = parseFloat(height);
    const deadweight = parseFloat(weight) / 1000;
    const volumetricWeight = (l * b * h) / 5000;
    const chargedWeight = weight * 1000;
    const gstRate = 18;

    const RateCards = plan?.rateCard || [];

    // ✅ Build isFlatRate lookup by _id — parallel fetch to save ~50-100ms
    const rcIds = RateCards.map((r) => r._id).filter(Boolean);
    const rateCardDocs = await RateCard.find({ _id: { $in: rcIds } }).lean().select("_id isFlatRate");
    const flatRateMap = new Map(
      rateCardDocs.map((doc) => [doc._id.toString(), doc.isFlatRate === true])
    );

    for (const rc of RateCards) {
      if (rc.status !== "Active") continue;
      // Use flag from object if present, otherwise fallback to lookup map (for legacy/sync cases)
      const isFlatRate = rc.isFlatRate === true || flatRateMap.get(rc._id?.toString()) === true;
      const basicChargeForward = parseFloat(
        rc.weightPriceBasic[0][currentZone],
      );
      const additionalChargeForward = parseFloat(
        rc.weightPriceAdditional[0][currentZone],
      );
      // console.log("basicChargeForward", basicChargeForward);
      // console.log("additionalChargeForward", additionalChargeForward);

      let totalForwardCharge;
      const count = Math.ceil(
        (chargedWeight - rc.weightPriceBasic[0].weight) /
        rc.weightPriceAdditional[0].weight,
      );
      // console.log("count", count);
      // console.log("chargedWeight", chargedWeight);
      if (rc.weightPriceBasic[0].weight >= chargedWeight) {
        totalForwardCharge = basicChargeForward;
        // console.log("totalForwardCharge111", totalForwardCharge);
      } else if (rc.weightPriceBasic[0].weight < chargedWeight) {
        totalForwardCharge =
          basicChargeForward + additionalChargeForward * count;
        // console.log("totalForwardCharge222", totalForwardCharge);
      }
      let codCharge = 0;
      if (cod === "Yes" && !isFlatRate) {
        const orderValue = Number(valueInINR) || 0;
        if (
          typeof rc.codCharge === "number" &&
          typeof rc.codPercent === "number"
        ) {
          const calculatedCodCharge = Math.max(
            rc.codCharge,
            orderValue * (rc.codPercent / 100),
          );
          codCharge += calculatedCodCharge;
        } else {
          console.error("COD charge or percentage is not properly defined.");
        }
      }
      let gstAmountForward = (
        (totalForwardCharge + codCharge) *
        (gstRate / 100)
      ).toFixed(2);

      const totalChargesForward = (
        totalForwardCharge +
        codCharge +
        parseFloat(gstAmountForward)
      ).toFixed(2);
      // console.log("totalChargesForward",totalChargesForward)
      const allRates = {
        courierServiceName: rc.courierServiceName,
        cod: codCharge,
        forward: {
          charges: totalForwardCharge,
          gst: gstAmountForward,
          finalCharges: totalChargesForward,
        },
      };

      ans.push(allRates);
    }
    // console.log("0000000", ans);
    return ans;
  } catch (error) {
    console.error("Error in Calculation:", error);
    throw new Error("Error in Calculation");
  }
}

async function calculateRateForDispute(payload) {
  try {
    const {
      pickupPincode,
      deliveryPincode,
      weight, // extra weight in KG
      cod,
      valueInINR,
      userID,
      filteredServices,
    } = payload;

    const gstRate = 18;

    // Parallel fetch: zone + plan
    const [zoneResult, plan] = await Promise.all([
      getZone(pickupPincode, deliveryPincode),
      Plan.findOne({ userId: userID }),
    ]);

    if (!zoneResult || !zoneResult.zone) {
      throw new Error("Zone information could not be determined");
    }

    const currentZone = zoneResult.zone;

    if (!plan) {
      throw new Error("Rate card not found for user");
    }

    const RateCards = plan.rateCard || [];

    const services = RateCards.filter(
      (rate) => rate.courierServiceName === filteredServices,
    );

    if (services.length === 0) {
      throw new Error("No matching service found");
    }

    // ✅ Fetch actual RateCard by _id for user-specific isFlatRate and status check
    // ✅ Check user-specific flag first, then fallback to global RateCard check
    const disputeIsFlatRate = services[0]?.isFlatRate === true || (await RateCard.findById(services[0]?._id))?.isFlatRate === true;

    // Convert extra weight from KG to grams
    const extraWeightInGrams = Math.ceil(parseFloat(weight) * 1000); // e.g., 2.88 kg → 2880 g

    const ans = [];

    for (const rc of services) {
      const additionalRate = rc.weightPriceAdditional?.[0];
      if (
        !additionalRate ||
        !additionalRate.weight ||
        !additionalRate[currentZone]
      ) {
        console.warn(
          `Skipping service ${rc.courierServiceName} due to missing rate info`,
        );
        continue;
      }

      const additionalWeight = additionalRate.weight; // in grams
      const additionalCharge = parseFloat(additionalRate[currentZone]); // per slab

      const count = Math.ceil(extraWeightInGrams / additionalWeight);
      let totalForwardCharge = count * additionalCharge;
      totalForwardCharge = parseFloat(totalForwardCharge.toFixed(2));

      let codCharge = 0;
      if (cod === "Yes" && !disputeIsFlatRate) {
        const orderValue = Number(valueInINR) || 0;
        if (
          typeof rc.codCharge === "number" &&
          typeof rc.codPercent === "number"
        ) {
          const calculatedCodCharge = Math.max(
            rc.codCharge,
            orderValue * (rc.codPercent / 100),
          );
          codCharge = parseFloat(calculatedCodCharge.toFixed(2));
        } else {
          console.warn("COD charge or percent not properly defined.");
        }
      }

      let gstAmountForward = parseFloat(
        ((totalForwardCharge + codCharge) * (gstRate / 100)).toFixed(2),
      );
      const totalChargesForward = parseFloat(
        (totalForwardCharge + codCharge + gstAmountForward).toFixed(2),
      );

      const allRates = {
        courierServiceName: rc.courierServiceName,
        cod: codCharge,
        forward: {
          charges: totalForwardCharge,
          gst: gstAmountForward,
          finalCharges: totalChargesForward,
        },
      };

      ans.push(allRates);
    }

    return ans;
  } catch (error) {
    console.error("Error in calculateRateForDispute:", error);
    throw new Error("Calculation failed");
  }
}

async function calculateRateForServiceBulk(payload) {
  try {
    const {
      pickupPincode,
      deliveryPincode,
      length,
      breadth,
      height,
      weight,
      cod,
      valueInINR,
      userID,
      filteredServices,
    } = payload;

    const { zone: currentZone } = await getZone(pickupPincode, deliveryPincode);

    const l = parseFloat(length);
    const b = parseFloat(breadth);
    const h = parseFloat(height);
    const chargedWeight = parseFloat(weight) * 1000; // weight in grams
    const gstRate = 18;

    const plan = await Plan.findOne({ userId: userID });
    if (!plan) throw new Error("Plan not found for user");

    // 🟢 Only find the matching courier from the plan rateCard
    const rc = plan.rateCard.find(
      (r) =>
        r.courierServiceName?.trim().toLowerCase() ===
        filteredServices.courierServiceName?.trim().toLowerCase(),
    );

    if (!rc || rc.status !== "Active") throw new Error("Selected courier not found or is currently inactive");

    // ✅ Fetch actual RateCard by _id for user-specific isFlatRate
    // ✅ Check user-specific flag first, then fallback to global RateCard check
    const isFlatRate = rc?.isFlatRate === true || (await RateCard.findById(rc?._id))?.isFlatRate === true;

    // Extract basic & additional weight/charges
    const basicWeight = parseFloat(rc.weightPriceBasic?.[0]?.weight || 0);
    const addWeight = parseFloat(rc.weightPriceAdditional?.[0]?.weight || 0);
    const basicCharge = parseFloat(
      rc.weightPriceBasic?.[0]?.[currentZone] || 0,
    );
    const addCharge = parseFloat(
      rc.weightPriceAdditional?.[0]?.[currentZone] || 0,
    );

    // 🧮 Calculate total forward charge
    let totalForwardCharge = 0;
    if (chargedWeight <= basicWeight) {
      totalForwardCharge = basicCharge;
    } else {
      const extraUnits = Math.ceil((chargedWeight - basicWeight) / addWeight);
      totalForwardCharge = basicCharge + addCharge * extraUnits;
    }

    // 🧾 COD charge calculation
    let codCharge = 0;
    if (cod === "Yes" && !isFlatRate) {
      const orderValue = Number(valueInINR) || 0;
      const baseCodCharge = parseFloat(rc.codCharge) || 0;
      const codPercent = parseFloat(rc.codPercent) || 0;
      codCharge = Math.max(baseCodCharge, orderValue * (codPercent / 100));
    }

    // 🧮 GST + Final total
    let gstAmount = ((totalForwardCharge + codCharge) * gstRate) / 100;
    const totalFinalCharge = totalForwardCharge + codCharge + gstAmount;

    const rateDetails = {
      courierServiceName: rc.courierServiceName,
      cod: codCharge.toFixed(2),
      forward: {
        charges: totalForwardCharge.toFixed(2),
        gst: gstAmount.toFixed(2),
        finalCharges: totalFinalCharge.toFixed(2),
      },
    };

    return [rateDetails];
  } catch (error) {
    console.error("Error in calculateRateForServiceBulk:", error.message);
    throw new Error("Failed to calculate courier rate");
  }
}

module.exports = {
  calculateRate,
  calculateRateForService,
  calculateRateForServiceBulk,
  calculateRateForDispute,
};
