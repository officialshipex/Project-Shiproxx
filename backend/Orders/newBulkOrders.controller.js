const mongoose = require("mongoose");
const Services = require("../models/CourierService.Schema");
const Courier = require("../models/AllCourierSchema");
const Order = require("../models/newOrder.model");
const BulkShipJob = require("../models/bulkShipJob.model");
const AppNotification = require("../models/appNotification.model");
const { getActor } = require("./bulkShipJob.controller");
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
const { createShipmentFunctionShipexIndia } = require("../AllCouriers/ShipxIndia/Courier/bulkShipment.controller");
const { createOrderJiffy } = require("../AllCouriers/Jiffy/Courier/bulkShipment.controller");


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
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let attemptError = null;
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
        case "ShipexIndia":
          result = await createShipmentFunctionShipexIndia(
            serviceDetails,
            order._id,
            wh,
            walletId,
            charges,
            priceBreakup
          );
          break;

        case "Jiffy":
          result = await createOrderJiffy(
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
          return { __bulkShipFailed: true, error: `No shipment function defined for ${serviceDetails.provider}` };
      }

      if (result?.status === 200 || result?.status === 201 || result?.success) {
        return result;
      } else {
        attemptError = result?.message || result?.error || "Provider call failed";
        throw new Error(attemptError);
      }
    } catch (error) {
      lastError = attemptError || error.message || "Provider call failed";
      console.error(`Attempt ${attempt} failed for order ${order._id}:`, error);
      if (attempt < maxRetries) await delay(retryDelay);
    }
  }
  return { __bulkShipFailed: true, error: lastError || "Provider call failed" };
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
      const courierErrors = [];
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
            courierErrors.push(`${courier.courierServiceName}: No rate available`);
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

          if (result && !result.__bulkShipFailed) {
            // success — provider returned AWB etc inside callProviderWithRetry
            return {
              success: true,
              courier: courier.courierServiceName,
              orderId,
            };
          }
          courierErrors.push(`${courier.courierServiceName}: ${result?.error || "failed"}`);
        } catch (err) {
          // try next courier
          console.warn(
            `Courier ${courier.courierServiceName} failed for order ${orderId}:`,
            err.message
          );
          courierErrors.push(`${courier.courierServiceName}: ${err.message}`);
          continue;
        }
      }

      // if reached here, all couriers failed
      const failureDetail = courierErrors.join("; ") || "All couriers failed";
      await Order.findByIdAndUpdate(orderId, {
        $set: { status: "new", failureReason: failureDetail },
      });
      return { success: false, reason: "all_couriers_failed", orderId, detail: failureDetail };
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

  function humanizeFailureReason(result) {
    const map = {
      already_claimed: "This order was already picked up by another shipment batch.",
      no_weight_slab: "No courier plan covers this order's weight.",
      all_couriers_failed: "All eligible couriers rejected or failed to ship this order.",
    };
    const base = map[result.reason] || result.reason || "Unknown error";
    return result.detail ? `${base} — ${result.detail}` : base;
  }

  // Runs after the 202 response has been sent. Tracks per-order progress on
  // the BulkShipJob doc so the frontend can poll live status instead of
  // waiting on a single all-or-nothing response.
  async function runBulkShipJob(jobId, selectedOrdersArr) {
    try {
      for (let i = 0; i < selectedOrdersArr.length; i++) {
        const oid = selectedOrdersArr[i];
        try {
          await BulkShipJob.updateOne(
            { _id: jobId },
            { $set: { [`results.${i}.status`]: "processing" } }
          );

          const result = await processSingleOrder(oid); // UNCHANGED shipment-creation logic

          if (result.success) {
            await BulkShipJob.updateOne(
              { _id: jobId },
              {
                $set: {
                  [`results.${i}.status`]: "success",
                  [`results.${i}.courierServiceName`]: result.courier,
                  [`results.${i}.completedAt`]: new Date(),
                },
                $inc: { successCount: 1 },
              }
            );
          } else {
            await BulkShipJob.updateOne(
              { _id: jobId },
              {
                $set: {
                  [`results.${i}.status`]: "failed",
                  [`results.${i}.failureReason`]: humanizeFailureReason(result),
                  [`results.${i}.completedAt`]: new Date(),
                },
                $inc: { failureCount: 1 },
              }
            );
          }
        } catch (iterErr) {
          console.error("Unexpected error processing order in bulk-ship job", jobId, oid, iterErr);
          await BulkShipJob.updateOne(
            { _id: jobId },
            {
              $set: {
                [`results.${i}.status`]: "failed",
                [`results.${i}.failureReason`]: "Unexpected error: " + iterErr.message,
                [`results.${i}.completedAt`]: new Date(),
              },
              $inc: { failureCount: 1 },
            }
          );
        }
      }
    } finally {
      // Unset activeSlot here (not just on acknowledge) so the partial
      // unique index self-cleans once processing finishes — nothing in the
      // new notification-driven UI ever calls acknowledgeBulkShipJob, so if
      // this weren't unset here, an actor's very first bulk-ship job would
      // permanently block every subsequent one with a 409.
      await BulkShipJob.updateOne(
        { _id: jobId },
        { $set: { status: "completed", completedAt: new Date() }, $unset: { activeSlot: "" } }
      );
    }
  }

  // ---------- MAIN controller flow ----------
  try {
    const dedupedOrders = [...new Set(selectedOrders)].filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );
    if (dedupedOrders.length === 0) {
      return res.status(400).json({ success: false, message: "No valid orders provided" });
    }

    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const ordersFound = await Order.find({ _id: { $in: dedupedOrders } }).select("orderId");
    const displayIdMap = new Map(ordersFound.map((o) => [String(o._id), o.orderId]));
    const results = dedupedOrders.map((id) => ({
      orderId: id,
      displayOrderId: displayIdMap.get(String(id)) ?? null,
      status: "pending",
    }));

    let job;
    try {
      job = await BulkShipJob.create({
        initiatedById: actor.id,
        initiatedByType: actor.type,
        totalOrders: dedupedOrders.length,
        results,
        activeSlot: true,
      });
    } catch (createErr) {
      if (createErr.code === 11000) {
        const existing = await BulkShipJob.findOne({
          initiatedById: actor.id,
          initiatedByType: actor.type,
          activeSlot: true,
        }).select("-results");
        return res.status(409).json({
          success: false,
          message: "A bulk shipment is already in progress or awaiting review. Please close it before starting a new one.",
          existingJobId: existing?._id,
          totalOrders: existing?.totalOrders,
        });
      }
      throw createErr;
    }

    try {
      await AppNotification.create({
        actorId: actor.id,
        actorType: actor.type,
        refModel: "BulkShipJob",
        refId: job._id,
        title: `Bulk Ship — ${dedupedOrders.length} orders`,
      });
    } catch (notifErr) {
      // Visibility is secondary to the actual shipment processing below —
      // never let a notification failure block or fail the bulk-ship request.
      console.error("Failed to create bulk-ship notification:", notifErr.message);
    }

    res.status(202).json({ success: true, jobId: job._id, totalOrders: job.totalOrders });

    setImmediate(() => {
      runBulkShipJob(job._id, dedupedOrders).catch((err) => {
        console.error("Bulk ship job failed unexpectedly:", job._id, err);
      });
    });
  } catch (outerErr) {
    console.error("Bulk order creation error:", outerErr);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: outerErr.message,
      });
    }
  }
};



module.exports = {
  updatePickup,
  shipBulkOrder,
  createBulkOrder,
};
