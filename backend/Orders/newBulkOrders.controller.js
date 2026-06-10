const Services = require("../models/CourierService.Schema");
const Courier = require("../models/AllCourierSchema");
const Order = require("../models/newOrder.model");
const plan = require("../models/Plan.model");
const User = require("../models/User.model");
const EDDMap = require("../models/EDDMap.model");
const { checkServiceabilityAll } = require("./shipment.controller");
const Wallet = require("../models/wallet");
const { AutoShip } = require("./AutoShipB2c.controller");
const { getZone } = require("../Rate/zoneManagementController");
const {
  calculateRateForService,
  calculateRateForServiceBulk,
} = require("../Rate/calculateRateController");

const {
  createShipmentFunctionDelhivery,
} = require("../AllCouriers/Delhivery/Courier/bulkShipment.controller");
const {
  createShipmentFunctionEcomExpress,
} = require("../AllCouriers/EcomExpress/Couriers/bulkShipment.controller");
const {
  createOrderDTDC,
} = require("../AllCouriers/DTDC/Courier/bulkShipment.controller");
const {
  createShipmentAmazon,
} = require("../AllCouriers/Amazon/Courier/bulkShipment.controller");
const {
  orderRegistrationOneStep,
} = require("../AllCouriers/SmartShip/Couriers/bulkShipment.controller");
const {
  createShipmentFunctionShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/bulkShipment.controller");
const {
  createOrderZipypost,
} = require("../AllCouriers/Zipypost/Couriers/bulkShipment.controller");
const { createOrderEkart } = require("../AllCouriers/Ekart/Couriers/bulkShipment.controller");
const { createOrderBoxdLogistics } = require("../AllCouriers/BoxdLogistics/Courier/bulkShipmentcontroller");
const { createOrderProship } = require("../AllCouriers/Proship/Courier/bulkShipment.controller");
const { createShipmentFunctionShipRocket } = require("../AllCouriers/ShipRocket/Courier/bulkShipment.controller");
const { createOrderShadowfax } = require("../AllCouriers/Shadowfax/Courier/bulkShipment.controller");
const { createOrderLosung360 } = require("../AllCouriers/Losung360/Courier/bulkShipment.controller");

const updatePickup = async (req, res) => {
  try {
    // console.log(req.body)
    const { formData, setSelectedData } = req.body;
    if (!setSelectedData || !formData) {
      return res
        .status(400)
        .json({ success: false, message: "id and pickup address not found" });
    }
    await Promise.all(
      setSelectedData.map(async (orderId) => {
        await Order.findByIdAndUpdate(orderId, {
          $set: { pickupAddress: formData },
        });
      })
    );
    res.status(200).json({ success: true, message: "Pickup address updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Atomically claim an order for processing
const claimOrder = async (orderId) => {
  return Order.findOneAndUpdate(
    { _id: orderId, status: "new" },
    { $set: { status: "processing", processingStartedAt: new Date() } },
    { new: true }
  );
};

const callProviderWithRetry = async (
  serviceDetails,
  order,
  wh,
  walletId,
  charges,
  priceBreakup,
  maxRetries = 1,
  retryDelay = 1000
) => {
  // console.log("service details",serviceDetails)
  // console.log("service",serviceDetails.provider)
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let result;
      switch (serviceDetails.provider) {
        case "NimbusPost":
          result = await createShipmentFunctionNimbusPost(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Amazon Shipping":
          result = await createShipmentAmazon(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          // console.log("result",result)
          break;
        case "Delhivery":
          result = await createShipmentFunctionDelhivery(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "EcomExpress":
          result = await createShipmentFunctionEcomExpress(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Dtdc":
          result = await createOrderDTDC(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Smartship":
          result = await orderRegistrationOneStep(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Shree Maruti":
          result = await createShipmentFunctionShreeMaruti(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "ZipyPost":
          result = await createOrderZipypost(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Ekart":
          result = await createOrderEkart(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "BoxdLogistics":
          result = await createOrderBoxdLogistics(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Proship":
          result = await createOrderProship(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Shiprocket":
          result = await createShipmentFunctionShipRocket(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Shadowfax":
          result = await createOrderShadowfax(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;
        case "Losung360":
          result = await createOrderLosung360(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;

        default:
          console.error(
            `No shipment function defined for ${serviceDetails.provider}`
          );
          return false;
      }

      if (result?.status === 200 || result?.status === 201 || result?.success) {
        return result;
      } else throw new Error("Provider call failed");
    } catch (error) {
      console.error(`Attempt ${attempt} failed for order ${order._id}:`, error);
      if (attempt < maxRetries) await delay(retryDelay);
    }
  }
  return false;
};

const shipBulkOrder = async (req, res) => {
  try {
    
    const { selectedOrders, pinCode } = req.body;
    // console.log(pinCode)
    const userID = req.user._id;
    const plans = await plan.find({ userId: userID });
    //  console.log("9999999999,",plans)
    const servicesCursor = await Services.find({ status: "Enable" });

    const enabledServices = [];

    for await (const srvc of servicesCursor) {
      const provider = await Courier.findOne({
        courierProvider: srvc.provider,
      });
      // console.log("7777777777",provider)
      if (provider?.status === "Enable") {
        enabledServices.push(srvc);
      }
    }

    const availableServices = await Promise.all(
      selectedOrders.map(async (item) => {
        const serviceable = await Promise.all(
          enabledServices.map(async (svc) => {
            const result = await checkServiceabilityAll(svc, item, pinCode);
            return result.success ? svc : null;
          })
        );
        return serviceable.filter(Boolean);
      })
    );
    // console.log("avail",availableServices)
    // console.log("enabled",enabledServices)
    const flatServices = availableServices.flat();

    // Deduplicate by name
    const flattenedAvailableService = [];
    const serviceNames = new Set();

    for (const svc of flatServices) {
      const nameKey = svc.name.trim().toLowerCase();
      if (!serviceNames.has(nameKey)) {
        serviceNames.add(nameKey);
        flattenedAvailableService.push(svc);
      }
    }
    // console.log(flattenedAvailableService);

    const fplans = plans.flatMap((plan) =>
      plan.rateCard
        .filter((item) => item.status === "Active")
        .map((item) => item.courierServiceName)
    );
    // console.log("Before filtering with fplans:");
    // flattenedAvailableService.forEach((svc) => console.log(`"${svc.name}"`));

    // console.log("fplans:");
    // fplans.forEach((plan) => console.log(`"${plan}"`));
    // console.log("fplans", fplans);

    const flattenedAvailableServices = flattenedAvailableService.filter(
      (item) =>
        fplans.some(
          (planName) =>
            planName
              .normalize("NFKC") // normalize unicode
              .replace(/\s+/g, " ") // replace multiple spaces with single
              .trim()
              .toLowerCase() ===
            item.name
              .normalize("NFKC")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase()
        )
    );

    // console.log("flattend",flattenedAvailableServices); // Only matched services will be returned

    // console.log(flattenedAvailableServices);

    res.status(201).json({
      success: true,
      services: flattenedAvailableServices,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch services",
      error: error.message,
    });
  }
};

// createBulkOrder controller - updated for immediate-response background processing for large batches

const createBulkOrder = async (req, res) => {
  const { selectedOrders } = req.body;
// console.log("order",selectedOrders)
  if (!Array.isArray(selectedOrders) || selectedOrders.length === 0) {
    return res
      .status(400)
      .json({ success: false, message: "No orders provided" });
  }

  // Helper: normalize string
  const normalize = (str) =>
    str?.toString().toLowerCase().replace(/\s+/g, "").trim();

  // Single-order processing logic extracted to a reusable function
  async function processSingleOrder(orderId) {
    try {
      // 1) Claim order (idempotency)
      const claimed = await claimOrder(orderId);
      if (!claimed) {
        // Already processed or claimed
        return { success: false, reason: "already_claimed", orderId };
      }

      // 2) Fetch order
      const order = await Order.findById(orderId);
      if (!order) throw new Error("Order details not found");

      // 3) Fetch user & plan
      const userId = order.userId;
      const user = await User.findById(userId);
      if (!user) throw new Error("User not found for order");

      const plans = await plan.findOne({ userId });
      if (!plans) throw new Error("User plan not found");

      const walletId = user.Wallet;
      const applicableWeight = order.packageDetails?.applicableWeight || 0;

      // 4) Prepare courier lists & EDD etc (grab fresh each order for correctness)
      const EDDRates = await EDDMap.find();
      const couriers = await Courier.find({ status: "Enable" });
      const courierServices = await Services.find({ status: "Enable" });
      // console.log("courierServices",courierServices)

      // 5) Determine eligible couriers (weight slab logic)
      let eligibleCouriers = (plans.rateCard || [])
        .filter((rc) => rc.status === "Active")
        .filter((rc) => {
          const weightSlab = rc.weightPriceBasic?.[0]?.weight / 1000 || 0;
          return weightSlab >= applicableWeight;
        });

        // console.log("eligibleCouriers",eligibleCouriers)

      if (eligibleCouriers.length > 0) {
        const minSlab = Math.min(
          ...eligibleCouriers.map(
            (rc) => rc.weightPriceBasic?.[0]?.weight / 1000 || 0
          )
        );
        eligibleCouriers = eligibleCouriers.filter(
          (rc) => (rc.weightPriceBasic?.[0]?.weight / 1000 || 0) === minSlab
        );
      }

      if (eligibleCouriers.length === 0) {
        // mark failure in DB and return
        await Order.findByIdAndUpdate(orderId, {
          $set: {
            status: "new",
            failureReason: "No courier available for this weight slab",
          },
        });
        return { success: false, reason: "no_weight_slab", orderId };
      }

      // filter enabled services/providers
      eligibleCouriers = eligibleCouriers.filter((rc) => {
        const service = courierServices.find(
          (cs) =>
            normalize(cs.name) === normalize(rc.courierServiceName) &&
            cs.status === "Enable"
        );
        const provider = couriers.find(
          (c) =>
            normalize(c.courierProvider) === normalize(rc.courierProviderName)
        );
        return !!service && provider?.status === "Enable";
      });

      // console.log("eligibleCouriers",eligibleCouriers)

      // zone and priority sorting
      const zone = await getZone(
        order.pickupAddress.pinCode,
        order.receiverAddress.pinCode
      );

      let priorityType = (plans.priorityType || "cheapest").toLowerCase();
      if (!["cheapest", "fastest", "custom"].includes(priorityType))
        priorityType = "cheapest";

      if (priorityType === "cheapest") {
        eligibleCouriers.sort((a, b) => {
          const costA = parseFloat(a.weightPriceBasic?.[0]?.[zone.zone] || 0);
          const costB = parseFloat(b.weightPriceBasic?.[0]?.[zone.zone] || 0);
          return costA - costB;
        });
      } else if (priorityType === "fastest") {
        eligibleCouriers.sort((a, b) => {
          const eddA = EDDRates.find(
            (e) => normalize(e.serviceName) === normalize(a.courierServiceName)
          );
          const eddB = EDDRates.find(
            (e) => normalize(e.serviceName) === normalize(b.courierServiceName)
          );
          const daysA = eddA?.zoneRates?.[zone.zone] ?? Number.MAX_SAFE_INTEGER;
          const daysB = eddB?.zoneRates?.[zone.zone] ?? Number.MAX_SAFE_INTEGER;
          return daysA - daysB;
        });
      } else if (priorityType === "custom") {
        const customOrder = (plans.rateCard || []).map((r) =>
          r?.courierServiceName?.toLowerCase()
        );
        eligibleCouriers.sort((a, b) => {
          return (
            customOrder.indexOf(a.courierServiceName?.toLowerCase()) -
            customOrder.indexOf(b.courierServiceName?.toLowerCase())
          );
        });
      }

      // Try couriers sequentially
      for (const courier of eligibleCouriers) {
        try {
          const details = {
            pickupPincode: order.pickupAddress.pinCode,
            deliveryPincode: order.receiverAddress.pinCode,
            length: order.packageDetails?.volumetricWeight?.length,
            breadth: order.packageDetails?.volumetricWeight?.width,
            height: order.packageDetails?.volumetricWeight?.height,
            weight: applicableWeight,
            cod: order.paymentDetails?.method === "COD" ? "Yes" : "No",
            valueInINR: order.paymentDetails?.amount,
            userID: userId,
            filteredServices: courier,
          };

          const rates = await calculateRateForServiceBulk(details);
          // console.log("rates", rates)
          const charges = parseFloat(rates?.[0]?.forward?.finalCharges || 0);

          if (!charges || isNaN(charges) || charges <= 0) {
            // skip this courier
            continue;
          }

          const courierDetails = {
            provider: courier.courierProviderName,
            name: courier.courierServiceName,
          };
          // console.log("courier",courierDetails)
          const priceBreakup = {
            freight: rates?.[0]?.forward?.charges,
            cod: rates?.[0]?.cod,
            gst: rates?.[0]?.forward?.gst,
            total: rates?.[0]?.forward?.finalCharges,
          }

          const result = await callProviderWithRetry(
            courierDetails,
            order,
            order.pickupAddress,
            walletId,
            charges,
            priceBreakup
          );

          if (result) {
            // success — provider returned AWB etc inside callProviderWithRetry
            return {
              success: true,
              courier: courier.courierServiceName,
              orderId,
            };
          }
        } catch (err) {
          // try next courier
          console.warn(
            `Courier ${courier.courierServiceName} failed for order ${orderId}:`,
            err.message
          );
          continue;
        }
      }

      // if reached here, all couriers failed
      await Order.findByIdAndUpdate(orderId, {
        $set: { status: "new", failureReason: "All couriers failed" },
      });
      return { success: false, reason: "all_couriers_failed", orderId };
    } catch (err) {
      // unexpected error - mark order as new & return failure
      try {
        await Order.findByIdAndUpdate(orderId, {
          $set: { status: "new", failureReason: err.message },
        });
      } catch (e) {
        console.error("Failed to set order failureReason:", e.message);
      }
      return { success: false, reason: err.message || "error", orderId };
    }
  } // end processSingleOrder

  // Background processor used when immediate response is sent
  async function processBulkOrdersBackground(selectedOrdersArr) {
    console.log(
      "BACKGROUND bulk processing started for",
      selectedOrdersArr.length,
      "orders"
    );
    let bgSuccess = 0;
    let bgFail = 0;

    for (const oid of selectedOrdersArr) {
      try {
        const result = await processSingleOrder(oid);
        if (result.success) bgSuccess++;
        else bgFail++;
        // optionally: emit websocket / notification or update a job collection for UI
      } catch (err) {
        console.error("Background order processing error", oid, err.message);
        bgFail++;
      }
      // do NOT delay in background to keep throughput (you can add small sleep if providers block you)
    }

    console.log(`BACKGROUND complete: success=${bgSuccess}, failure=${bgFail}`);
  }

  // ---------- MAIN controller flow ----------
  try {
    // If large batch — return immediately and process background
    if (selectedOrders.length >= 15) {
      const approxMinutes = Math.ceil(selectedOrders.length * 0.15); // heuristic
      // Respond right away
      res.status(202).json({
        success: true,
        message: `Bulk shipment started for ${selectedOrders.length} orders. Please check Ready To Ship tab after approx ${approxMinutes} minutes.`,
      });

      // Run background processing without blocking response
      // setImmediate ensures this runs after the response has been sent
      setImmediate(() => {
        processBulkOrdersBackground(selectedOrders).catch((err) => {
          console.error("Background processing failed:", err);
        });
      });

      return; // done
    }

    // ---------- Small batch synchronous processing (< 15 orders) ----------
    let successCount = 0;
    let failureCount = 0;

    for (const orderId of selectedOrders) {
      const result = await processSingleOrder(orderId);
      if (result.success) successCount++;
      else failureCount++;

      // Preserve small-batch delay if you want (keeps old behavior)
      if (typeof delay === "function") {
        try {
          await delay(1000);
        } catch (e) {
          // ignore delay errors
        }
      }
    }

    return res.status(201).json({
      success: true,
      message: `${successCount} orders created successfully & ${failureCount} failed.`,
      successCount,
      failureCount,
    });
  } catch (outerErr) {
    console.error("Bulk order creation error:", outerErr);
    // If response has not been sent yet, send server error, otherwise just log
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: outerErr.message,
      });
    } else {
      // response already sent (shouldn't happen because large batches responded earlier),
      // but log error for debugging
      return;
    }
  }
};



module.exports = {
  updatePickup,
  shipBulkOrder,
  createBulkOrder,
};
