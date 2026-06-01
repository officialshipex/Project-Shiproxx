const ExcelJS = require("exceljs");
const xlsx = require("xlsx");
const fs = require("fs");
const Order = require("../models/newOrder.model");
const WeightDiscrepancy = require("./weightDispreancy.model");
const Wallet = require("../models/wallet");
const User = require("../models/User.model");
const cron = require("node-cron");
const { uploadToS3 } = require("../config/s3");
const { calculateRateForDispute } = require("../Rate/calculateRateController");
const Plan = require("../models/Plan.model");
const mongoose = require("mongoose");
const WalletTransaction = require("../models/WalletTransaction.model");
const RateCard = require("../models/rateCards");
const { getZone } = require("../Rate/zoneManagementController");

const downloadExcel = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Weight Discrepancy");

    // Define headers
    worksheet.columns = [
      { header: "*AWB Number", key: "awb_number", width: 30 },
      { header: "*Charge Weight", key: "charge_weight", width: 20 },
      { header: "Length", key: "length", width: 15 },
      { header: "Breadth", key: "breadth", width: 15 },
      { header: "Height", key: "height", width: 15 },
    ];

    // Add a sample row
    worksheet.addRow({
      awb_number: "1212121212",
      charge_weight: "0.5",
      length: "10",
      breadth: "10",
      height: "10",
    });

    // Format header row (bold and centered)
    worksheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    // Generate the Excel file in memory
    const buffer = await workbook.xlsx.writeBuffer();

    // Set headers for file download
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Weight_Discrepancy_Sample_Format.xlsx"
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.send(Buffer.from(buffer)); // ✅ Fix for corruption issue
  } catch (error) {
    console.error("Error generating Excel file:", error);
    res.status(500).json({ error: "Error generating Excel file" });
  }
};

// ─── Background worker ────────────────────────────────────────────────────────
// Called AFTER the HTTP response is already sent so the client is never blocked.
async function _processDiscrepancyBatch(awbNumbers, chargeWeightMap, filePath) {
  try {
    // 1. already existing discrepancies (batch query)
    const existing = await WeightDiscrepancy.find({
      awbNumber: { $in: awbNumbers },
    }).select("awbNumber").lean();
    const existingSet = new Set(existing.map((e) => e.awbNumber));

    // 2. Fetch orders in one query with only the fields we need
    const orders = await Order.find({ awb_number: { $in: awbNumbers } })
      .select(
        "awb_number orderId userId status courierServiceName provider " +
        "productDetails pickupAddress receiverAddress packageDetails paymentDetails"
      )
      .lean();
    const orderMap = new Map(orders.map((o) => [o.awb_number, o]));

    // 3. Collect unique userIds + unique pincode pairs in one pass
    const userIdsSet = new Set();
    const uniquePincodePairs = [];
    const seenPairs = new Set();

    for (const awb of awbNumbers) {
      if (existingSet.has(awb)) continue;
      const chargeData = chargeWeightMap[awb];
      if (!chargeData) continue;
      const order = orderMap.get(awb);
      if (!order) continue;
      if (
        order.status === "Booked" ||
        order.status === "Not Picked" ||
        order.status === "Ready To Ship"
      ) continue;

      if (order.userId) userIdsSet.add(order.userId.toString());

      const pickupPincode = order.pickupAddress?.pinCode;
      const deliveryPincode = order.receiverAddress?.pinCode;
      if (pickupPincode && deliveryPincode) {
        const cacheKey = `${pickupPincode}_${deliveryPincode}`;
        if (!seenPairs.has(cacheKey)) {
          seenPairs.add(cacheKey);
          uniquePincodePairs.push({ pickupPincode, deliveryPincode, cacheKey });
        }
      }
    }

    const userIds = Array.from(userIdsSet);
    if (userIds.length === 0) {
      fs.promises.unlink(filePath).catch(() => {});
      return;
    }

    // 4. Zone cache — pre-resolve all unique pincode pairs in parallel batches of 20
    const zoneCache = new Map();
    const ZONE_BATCH = 20;
    for (let i = 0; i < uniquePincodePairs.length; i += ZONE_BATCH) {
      const chunk = uniquePincodePairs.slice(i, i + ZONE_BATCH);
      await Promise.all(
        chunk.map(async (pair) => {
          try {
            const zoneResult = await getZone(pair.pickupPincode, pair.deliveryPincode);
            zoneCache.set(pair.cacheKey, zoneResult?.zone || null);
          } catch (_) {
            zoneCache.set(pair.cacheKey, null);
          }
        })
      );
    }

    // 5. Parallel fetch: plans + users
    const [allPlans, allUsers] = await Promise.all([
      Plan.find({ userId: { $in: userIds } }).lean(),
      User.find({ _id: { $in: userIds } }).select("Wallet").lean(),
    ]);

    const planMap = new Map(allPlans.map((p) => [p.userId.toString(), p]));
    const userMap = new Map(allUsers.map((u) => [u._id.toString(), u]));

    // 6. Fetch isFlatRate flags for all relevant rate cards in one query
    const rateCardIdsSet = new Set();
    for (const plan of allPlans) {
      if (plan.rateCard && Array.isArray(plan.rateCard)) {
        for (const rc of plan.rateCard) {
          if (rc && rc._id) rateCardIdsSet.add(rc._id.toString());
        }
      }
    }
    const rateCardsList = await RateCard.find({
      _id: { $in: Array.from(rateCardIdsSet) },
    }).select("_id isFlatRate").lean();
    const rateCardFlatRateMap = new Map(
      rateCardsList.map((rc) => [rc._id.toString(), rc.isFlatRate === true])
    );

    // 7. Build discrepancies — fully synchronous now (no await in loop)
    const discrepancies = [];
    const gstRate = 18;

    for (const awb of awbNumbers) {
      if (existingSet.has(awb)) continue;

      const chargeData = chargeWeightMap[awb];
      if (!chargeData) continue;

      const order = orderMap.get(awb);
      if (!order) continue;
      if (
        order.status === "Booked" ||
        order.status === "Not Picked" ||
        order.status === "Ready To Ship"
      ) continue;

      const userId = order.userId.toString();
      const userPlan = planMap.get(userId);
      if (!userPlan || !userPlan.rateCard) continue;

      const matchedRateCard = userPlan.rateCard.find(
        (r) => r.courierServiceName === order.courierServiceName
      );
      if (
        !matchedRateCard ||
        !matchedRateCard.weightPriceBasic?.length ||
        !matchedRateCard.weightPriceAdditional?.length
      ) continue;

      const basicWeightSlabGrams = matchedRateCard.weightPriceBasic[0].weight;
      const additionalWeightSlabGrams = matchedRateCard.weightPriceAdditional[0].weight;

      const deadWeightKg = order.packageDetails.deadWeight || 0;
      const volumetricWeightKg =
        ((order.packageDetails.volumetricWeight?.length || 0) *
          (order.packageDetails.volumetricWeight?.width || 0) *
          (order.packageDetails.volumetricWeight?.height || 0)) /
        5000;
      const actualWeightKg = order.packageDetails.applicableWeight || 0;
      const applicableWeightKg = Math.max(volumetricWeightKg, actualWeightKg);

      const roundedApplicableGrams =
        Math.ceil((applicableWeightKg * 1000) / basicWeightSlabGrams) * basicWeightSlabGrams;
      const chargedGrams =
        Math.ceil((chargeData.chargeWeight * 1000) / additionalWeightSlabGrams) * additionalWeightSlabGrams;

      if (chargedGrams <= basicWeightSlabGrams) continue;
      if (chargedGrams <= roundedApplicableGrams) continue;

      let excessGrams = chargedGrams - roundedApplicableGrams;
      excessGrams = Math.ceil(excessGrams / additionalWeightSlabGrams) * additionalWeightSlabGrams;
      const excessWeight = parseFloat((excessGrams / 1000).toFixed(2));
      if (excessWeight <= 0) continue;

      const pickupPincode = order.pickupAddress.pinCode;
      const deliveryPincode = order.receiverAddress.pinCode;
      const cacheKey = `${pickupPincode}_${deliveryPincode}`;
      const currentZone = zoneCache.get(cacheKey);
      if (!currentZone) continue;

      const services = userPlan.rateCard.filter(
        (rate) => rate.courierServiceName === order.courierServiceName
      );
      if (services.length === 0) continue;

      const firstRc = services[0];
      const additionalRate = firstRc.weightPriceAdditional?.[0];
      if (!additionalRate || !additionalRate.weight || !additionalRate[currentZone]) continue;

      const disputeIsFlatRate =
        firstRc.isFlatRate === true ||
        (firstRc._id && rateCardFlatRateMap.get(firstRc._id.toString()) === true);

      const extraWeightInGrams = Math.ceil(excessWeight * 1000);
      const count = Math.ceil(extraWeightInGrams / additionalRate.weight);
      let totalForwardCharge = parseFloat((count * parseFloat(additionalRate[currentZone])).toFixed(2));

      let codCharge = 0;
      if (order.paymentDetails.method === "COD" && !disputeIsFlatRate) {
        const orderValue = Number(order.paymentDetails.amount) || 0;
        if (typeof firstRc.codCharge === "number" && typeof firstRc.codPercent === "number") {
          codCharge = parseFloat(
            Math.max(firstRc.codCharge, orderValue * (firstRc.codPercent / 100)).toFixed(2)
          );
        }
      }

      const gstAmountForward = parseFloat(
        ((totalForwardCharge + codCharge) * (gstRate / 100)).toFixed(2)
      );

      discrepancies.push(
        new WeightDiscrepancy({
          userId,
          awbNumber: order.awb_number,
          orderId: order.orderId,
          productDetails: order.productDetails,
          courierServiceName: order.courierServiceName || order.provider,
          provider: order.provider,
          enteredWeight: {
            applicableWeight: roundedApplicableGrams / 1000,
            deadWeight: deadWeightKg,
            volumetricWeight: order.packageDetails.volumetricWeight,
          },
          chargedWeight: {
            applicableWeight: chargedGrams / 1000,
            deadWeight: chargeData.chargeWeight,
          },
          chargeDimension: {
            length: chargeData.length,
            breadth: chargeData.breadth,
            height: chargeData.height,
          },
          excessWeightCharges: {
            excessWeight,
            excessCharges: totalForwardCharge + gstAmountForward,
            pendingAmount: totalForwardCharge + gstAmountForward,
            priceBreakup: {
              freight: totalForwardCharge,
              gst: gstAmountForward,
            },
          },
          status: "new",
          adminStatus: "pending",
        })
      );
    }

    // 8. Save discrepancies + update wallets
    if (discrepancies.length > 0) {
      const walletUpdates = new Map();
      for (const d of discrepancies) {
        const userDetails = userMap.get(d.userId.toString());
        if (!userDetails?.Wallet) continue;
        const amount = Number(d.excessWeightCharges.pendingAmount || 0);
        if (amount <= 0) continue;
        const wid = userDetails.Wallet.toString();
        walletUpdates.set(wid, (walletUpdates.get(wid) || 0) + amount);
      }

      const walletBulkOps = [];
      for (const [walletId, amount] of walletUpdates.entries()) {
        walletBulkOps.push({
          updateOne: {
            filter: { _id: walletId },
            update: { $inc: { holdAmount: amount } },
          },
        });
      }

      await Promise.all([
        WeightDiscrepancy.insertMany(discrepancies, { ordered: false }),
        walletBulkOps.length > 0 ? Wallet.bulkWrite(walletBulkOps) : Promise.resolve(),
      ]);
    }
  } catch (err) {
    console.error("[uploadDispreancy background] Error:", err);
  } finally {
    fs.promises.unlink(filePath).catch(() => {});
  }
}

const uploadDispreancy = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const filePath = req.file.path;

    // Parse Excel synchronously — this is fast and uses no DB connections
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheetData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const awbNumbers = sheetData
      .map((row) => row["*AWB Number"]?.toString().trim())
      .filter(Boolean);

    if (awbNumbers.length === 0) {
      fs.promises.unlink(filePath).catch(() => {});
      return res.status(400).json({ success: false, error: "No valid AWB numbers found in file" });
    }

    const chargeWeightMap = {};
    for (const row of sheetData) {
      const awb = row["*AWB Number"]?.toString().trim();
      const chargeWeight = parseFloat(row["*Charge Weight"]);
      if (awb && !isNaN(chargeWeight)) {
        chargeWeightMap[awb] = {
          chargeWeight,
          length: parseFloat(row["Length"]) || null,
          breadth: parseFloat(row["Breadth"]) || null,
          height: parseFloat(row["Height"]) || null,
        };
      }
    }

    // ✅ Release the HTTP connection IMMEDIATELY — UI is unblocked
    res.status(200).json({
      success: true,
      message: "File received. Discrepancies are being processed in the background.",
    });

    // 🔄 Run all heavy DB work AFTER response is sent
    setImmediate(() => {
      _processDiscrepancyBatch(awbNumbers, chargeWeightMap, filePath).catch((err) => {
        console.error("[uploadDispreancy] Background batch failed:", err);
      });
    });
  } catch (error) {
    console.error("Error parsing upload:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: "Internal Server Error" });
    }
  }
};

const AllDiscrepancy = async (req, res) => {
  try {
    const statusCounts = await WeightDiscrepancy.aggregate([
      {
        $group: {
          _id: "$adminStatus", // group by status field
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          status: "$_id",
          count: 1,
          _id: 0,
        },
      },
    ]);

    res.status(200).json({
      success: true,
      data: {
        statusCounts, // e.g., [{ status: "Resolved", count: 4 }, ...]
        discrepancies: [], // Removed massive global fetch, frontend paginated tables handle data independently
      },
    });
  } catch (error) {
    console.error("Error fetching discrepancies:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

const getAllDiscrepancy = async (req, res) => {
  try {
    const {
      userSearch,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
      awbNumber,
      orderId,
      status,
      courierService,
    } = req.query;
    // console.log("re", req.query);
    const userMatchStage = {};
    const discrepancyMatchStage = {};

    // User search filter
    if (userSearch) {
      const regex = new RegExp(userSearch, "i");
      if (mongoose.Types.ObjectId.isValid(userSearch)) {
        userMatchStage["$or"] = [
          { "user._id": new mongoose.Types.ObjectId(userSearch) },
          { "user.email": regex },
          { "user.fullname": regex },
        ];
      } else {
        userMatchStage["$or"] = [
          { "user.email": regex },
          { "user.fullname": regex },
        ];
      }
    }

    // Date range filter
    if (fromDate && toDate) {
      const startDate = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
      const endDate = new Date(new Date(toDate).setHours(23, 59, 59, 999));
      discrepancyMatchStage["createdAt"] = { $gte: startDate, $lte: endDate };
    }

    if (status) {
      discrepancyMatchStage["adminStatus"] = status;
    }

    if (awbNumber) {
      discrepancyMatchStage["awbNumber"] = awbNumber;
    }

    if (orderId) {
      discrepancyMatchStage["orderId"] = Number(orderId);
    }

    // ✅ Courier Service Name filter (multiple support)
    if (courierService) {
      const servicesArray = courierService
        .split(",")
        .map((item) => item.trim());

      discrepancyMatchStage.courierServiceName = {
        $in: servicesArray,
      };
    }

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * parsedLimit;

    const basePipeline = [
      { $match: discrepancyMatchStage },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      { $match: userMatchStage },
      {
        $project: {
          _id: 1,
          userId: "$userId",
          awbNumber: 1,
          orderId: 1,
          courierServiceName: 1,
          provider: 1,
          productDetails: 1,
          enteredWeight: 1,
          chargedWeight: 1,
          chargeDimension: 1,
          excessWeightCharges: 1,
          status: 1,
          adminStatus: 1,
          clientStatus: 1,
          createdAt: 1,
          updatedAt: 1,
          text: 1,
          imageUrl: 1,
          user: {
            userId: "$user.userId",
            name: "$user.fullname",
            email: "$user.email",
            phoneNumber: "$user.phoneNumber",
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ];

    const [results, totalResult] = await Promise.all([
      parsedLimit === 0
        ? WeightDiscrepancy.aggregate(basePipeline)
        : WeightDiscrepancy.aggregate([
          ...basePipeline,
          { $skip: skip },
          { $limit: parsedLimit },
        ]),

      WeightDiscrepancy.aggregate([...basePipeline, { $count: "total" }]),
    ]);

    const total = totalResult[0]?.total || 0;

    // Extract unique courier services for filter dropdown
    const courierServices = await WeightDiscrepancy.distinct("courierServiceName", {
      ...discrepancyMatchStage,
      courierServiceName: { $exists: true, $ne: null, $ne: "" }
    });

    return res.json({
      total,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results,
      courierServices: courierServices.filter(Boolean).sort(),
    });
  } catch (error) {
    console.error("Error fetching discrepancies:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// const mongoose = require("mongoose");

const AllDiscrepancyCountBasedId = async (req, res) => {
  try {
    const { id } = req.query;
    let userId;
    if (id) {
      userId = new mongoose.Types.ObjectId(id); // convert to ObjectId
    } else {
      userId = req.user?._id || req.employee?._id;
    }

    const statusCounts = await WeightDiscrepancy.aggregate([
      {
        $match: { userId }, // correctly matched ObjectId
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          status: "$_id",
          count: 1,
          _id: 0,
        },
      },
    ]);

    const discrepancies = await WeightDiscrepancy.find({ userId }).lean();

    if (!discrepancies.length) {
      return res.status(404).json({
        success: false,
        message: "No discrepancies found",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        statusCounts,
        discrepancies,
      },
    });
  } catch (error) {
    console.error("Error fetching user discrepancies:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

const AllDiscrepancyBasedId = async (req, res) => {
  try {
    const {
      id,
      fromDate,
      toDate,
      page = 1,
      limit = 20,
      awbNumber,
      orderId,
      status,
      courierServiceName,
    } = req.query;
    let userId;
    // console.log("id",req.query)
    if (id) {
      userId = id;
    } else {
      userId = req.user?._id || req.employee?._id;
    }
    // const userId = req.user._id;
    const discrepancyMatchStage = {
      userId: new mongoose.Types.ObjectId(userId),
    };

    // Date range filter
    if (fromDate && toDate) {
      const startDate = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
      const endDate = new Date(new Date(toDate).setHours(23, 59, 59, 999));
      discrepancyMatchStage["createdAt"] = { $gte: startDate, $lte: endDate };
    }

    if (status) {
      discrepancyMatchStage["status"] = status;
    }

    if (awbNumber) {
      discrepancyMatchStage["awbNumber"] = awbNumber;
    }

    if (orderId) {
      discrepancyMatchStage["orderId"] = Number(orderId);
    }

    // ✅ Courier Service Name filter (multiple support)
    if (courierServiceName) {
      const servicesArray = courierServiceName
        .split(",")
        .map((item) => item.trim());

      discrepancyMatchStage.courierServiceName = {
        $in: servicesArray,
      };
    }

    const parsedLimit = limit.toLowerCase() === "all" ? null : Number(limit);
    const skip = parsedLimit ? (Number(page) - 1) * parsedLimit : 0;

    const basePipeline = [
      { $match: discrepancyMatchStage },
      {
        $project: {
          _id: 1,
          userId: "$userId",
          awbNumber: 1,
          orderId: 1,
          courierServiceName: 1,
          provider: 1,
          productDetails: 1,
          enteredWeight: 1,
          chargedWeight: 1,
          chargeDimension: 1,
          excessWeightCharges: 1,
          status: 1,
          adminStatus: 1,
          clientStatus: 1,
          createdAt: 1,
          updatedAt: 1,
          text: 1,
          imageUrl: 1,
          discrepancyDeclinedReason: 1,
        },
      },
      { $sort: { createdAt: -1 } },
    ];

    const [results, totalResult] = await Promise.all([
      parsedLimit === null
        ? WeightDiscrepancy.aggregate(basePipeline)
        : WeightDiscrepancy.aggregate([
          ...basePipeline,
          { $skip: skip },
          { $limit: parsedLimit },
        ]),
      WeightDiscrepancy.aggregate([...basePipeline, { $count: "total" }]),
    ]);

    const total = totalResult[0]?.total || 0;
    const totalPages = parsedLimit ? Math.ceil(total / parsedLimit) : 1;

    // Extract unique courier services for filter dropdown
    const courierServices = await WeightDiscrepancy.distinct("courierServiceName", {
      ...discrepancyMatchStage,
      courierServiceName: { $exists: true, $ne: null, $ne: "" }
    });

    return res.json({
      total,
      page: Number(page),
      limit: parsedLimit ?? "all",
      page: totalPages,
      currentPage: Number(page),
      results,
      courierServices: courierServices.filter(Boolean).sort(),
    });
  } catch (error) {
    console.error("Error fetching user discrepancies:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

const AcceptDiscrepancy = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user._id;
    const { awb_number } = req.body;

    // 1. Fetch discrepancy inside session
    const discrepancies = await WeightDiscrepancy.findOne(
      { awbNumber: awb_number },
      null,
      { session }
    );

    if (!discrepancies) {
      await session.abortTransaction();
      session.endSession();
      return res
        .status(404)
        .json({ success: false, message: "Discrepancy not found" });
    }

    if (discrepancies.status !== "new") {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Discrepancy already processed",
      });
    }

    const extraCharges = parseFloat(
      discrepancies.excessWeightCharges.excessCharges
    );

    const user = await User.findById(userId, null, { session });
    if (!user) throw new Error("User not found");

    const wallet = await Wallet.findById(user.Wallet, "balance holdAmount", { session });
    if (!wallet) throw new Error("Wallet not found");

    if (wallet.balance < extraCharges) {
      throw new Error("Insufficient wallet balance");
    }

    // Deduct atomically
    wallet.balance = parseFloat((wallet.balance - extraCharges).toFixed(2));
    wallet.holdAmount = Math.max(
      0,
      parseFloat((wallet.holdAmount - extraCharges).toFixed(2))
    );

    const newTransaction = {
      channelOrderId: discrepancies.orderId,
      category: "debit",
      amount: extraCharges,
      balanceAfterTransaction: wallet.balance,
      awb_number: awb_number,
      description: `Weight Dispute Charges Applied`,
      priceBreakup: discrepancies.excessWeightCharges?.priceBreakup,
    };
    await WalletTransaction.create([{ walletId: wallet._id, ...newTransaction }], { session });

    await wallet.save({ session });

    discrepancies.status = "Accepted";
    discrepancies.clientStatus = "Accepted by Client";
    discrepancies.adminStatus = "Accepted";
    discrepancies.excessWeightCharges.pendingAmount = 0;
    await discrepancies.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      success: true,
      message: "Discrepancy accepted successfully",
      updatedWalletBalance: wallet.balance,
      updatedHoldAmount: wallet.holdAmount,
      transaction: newTransaction,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error in AcceptDiscrepancy:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const AcceptAllDiscrepancies = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user._id;
    const { orderIds } = req.body;

    if (!orderIds || orderIds.length === 0) {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ success: false, message: "No order IDs provided" });
    }

    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount").session(session);
    if (!wallet) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found" });
    }

    let discrepanciesToUpdate = [];

    for (const orderId of orderIds) {
      const discrepancy = await WeightDiscrepancy.findById(orderId).session(
        session
      );

      if (!discrepancy) {
        await session.abortTransaction();
        return res.status(404).json({
          success: false,
          message: `Discrepancy not found for ID: ${orderId}`,
        });
      }

      if (discrepancy.status !== "new") {
        continue; // skip already processed
      }

      const extraCharges = parseFloat(
        discrepancy.excessWeightCharges.excessCharges
      );

      discrepanciesToUpdate.push({ discrepancy, extraCharges });
    }

    if (discrepanciesToUpdate.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "No new discrepancies found to accept",
      });
    }

    // Sequentially deduct per discrepancy
    for (const { discrepancy, extraCharges } of discrepanciesToUpdate) {
      wallet.balance = parseFloat((wallet.balance - extraCharges).toFixed(2));
      wallet.holdAmount = Math.max(
        0,
        parseFloat((wallet.holdAmount - extraCharges).toFixed(2))
      );

      const newTransaction = {
        channelOrderId: discrepancy.orderId,
        category: "debit",
        amount: extraCharges,
        balanceAfterTransaction: wallet.balance, // ✅ updated per order
        awb_number: discrepancy.awbNumber,
        description: "Weight Dispute Charges Applied",
        priceBreakup: discrepancy.excessWeightCharges?.priceBreakup,
        createdAt: new Date(),
      };

      await WalletTransaction.create([{ walletId: wallet._id, ...newTransaction }], { session });

      // update discrepancy
      discrepancy.status = "Accepted";
      discrepancy.clientStatus = "Accepted by Client";
      discrepancy.adminStatus = "Accepted";
      discrepancy.excessWeightCharges.pendingAmount = 0;

      await discrepancy.save({ session });
    }

    await wallet.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      success: true,
      message: "All valid discrepancies accepted",
      updatedWalletBalance: wallet.balance,
      updatedHoldAmount: wallet.holdAmount,
      totalAccepted: discrepanciesToUpdate.length,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error in AcceptAllDiscrepancies:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const autoAcceptDiscrepancies = async () => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    console.log("Running auto-accept discrepancy job...");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const discrepancies = await WeightDiscrepancy.find({
      status: "new",
      createdAt: { $lte: sevenDaysAgo },
    }).session(session);

    for (const discrepancy of discrepancies) {
      const user = await User.findById(discrepancy.userId).session(session);
      if (!user) {
        console.log(`User not found for discrepancy ${discrepancy.awbNumber}`);
        continue;
      }

      const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount").session(session);
      if (!wallet) {
        console.log(`Wallet not found for user ${user._id}`);
        continue;
      }

      const extraCharges = parseFloat(
        discrepancy.excessWeightCharges?.excessCharges || 0
      );
      if (extraCharges <= 0) {
        console.log(
          `No extra charges found for discrepancy ${discrepancy.awbNumber}`
        );
        continue;
      }

      // Deduct from balance and holdAmount safely
      wallet.balance = parseFloat((wallet.balance - extraCharges).toFixed(2));
      wallet.holdAmount = Math.max(
        0,
        parseFloat((wallet.holdAmount - extraCharges).toFixed(2))
      );

      const newTransaction = {
        channelOrderId: discrepancy.orderId,
        category: "debit",
        amount: extraCharges,
        balanceAfterTransaction: wallet.balance,
        awb_number: discrepancy.awbNumber,
        description: `Auto-accepted Weight Dispute charge`,
        priceBreakup: discrepancy.excessWeightCharges?.priceBreakup,
        createdAt: new Date(),
      };

      await WalletTransaction.create([{ walletId: wallet._id, ...newTransaction }], { session });

      await wallet.save({ session });

      discrepancy.status = "Accepted";
      discrepancy.clientStatus = "Auto Accepted";
      discrepancy.adminStatus = "Accepted";
      discrepancy.excessWeightCharges.pendingAmount = 0;
      await discrepancy.save({ session });

      console.log(
        `Discrepancy ${discrepancy.awbNumber} auto-accepted. Updated Wallet Balance: ${wallet.balance}, HoldAmount: ${wallet.holdAmount}`
      );
    }

    await session.commitTransaction();
    session.endSession();

    console.log("Auto-accept discrepancy job completed.");
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Error in autoAcceptDiscrepancies:", error);
  }
};

// Schedule job to run every day at midnight
if (process.env.NODE_ENV === "production") {
  cron.schedule("0 0 * * *", autoAcceptDiscrepancies, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
}

// autoAcceptDiscrepancies()

// Raise Discrepancies
const raiseDiscrepancies = async (req, res) => {
  try {
    const { awbNumber, text } = req.body;
    // console.log(awbNumber, text);

    // Validate Input
    if (!awbNumber || !text) {
      return res
        .status(400)
        .json({ message: "AWB Number and text are required" });
    }
    if (!req.file) {
      return res.status(400).json({ message: "Image file is required" });
    }

    // Get Image URL from multer-s3
    const imageUrl = req.file.location;
    // console.log("Image URL:", imageUrl);

    // Find and update existing discrepancy
    const updatedPost = await WeightDiscrepancy.findOneAndUpdate(
      { awbNumber }, // Find by AWB Number
      {
        text,
        imageUrl,
        status: "Discrepancy Raised",
        adminStatus: "Discrepancy Raised",
        clientStatus: "Discrepancy Raised",
        discrepancyRaisedAt: new Date(),
      },
      { new: true, upsert: false } // Return updated document, do not create a new one if not found
    );

    if (!updatedPost) {
      return res
        .status(404)
        .json({ message: "No existing discrepancy found for this AWB Number" });
    }

    res.status(200).json({
      message: "Discrepancy updated successfully",
      post: updatedPost,
    });
  } catch (error) {
    console.error("Error updating discrepancy:", error);
    res.status(500).json({
      message: "Server Error",
      error: error.message,
    });
  }
};

const adminAcceptDiscrepancy = async (req, res) => {
  try {
    const { awbNumber } = req.body;
    console.log("Accepting discrepancy for AWB:", awbNumber);

    // Find discrepancy by AWB number
    const discrepancy = await WeightDiscrepancy.findOne({ awbNumber });
    if (!discrepancy) {
      return res.status(404).json({ message: "Discrepancy not found" });
    }

    // Only proceed if adminStatus is "Discrepancy Raised"
    if (discrepancy.adminStatus !== "Discrepancy Raised") {
      return res
        .status(400)
        .json({ message: "Discrepancy is not raised by admin" });
    }

    // Fetch user and wallet
    const user = await User.findById(discrepancy.userId);
    if (!user) {
      return res
        .status(404)
        .json({ message: "User not found for this discrepancy" });
    }

    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount");
    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found for user" });
    }

    // Deduct from holdAmount
    const extraCharges = parseFloat(
      discrepancy.excessWeightCharges?.excessCharges || 0
    );
    wallet.holdAmount = Math.max(
      0,
      parseFloat((wallet.holdAmount - extraCharges).toFixed(2))
    );
    await wallet.save();

    // Update discrepancy
    discrepancy.excessWeightCharges.pendingAmount = 0;
    discrepancy.status = "Accepted";
    discrepancy.adminStatus = "Discrepancy Accepted";
    discrepancy.clientStatus = "Discrepancy Accepted";
    discrepancy.discrepancyAcceptedAt = new Date();
    await discrepancy.save();

    res.status(200).json({ message: "Discrepancy accepted successfully" });
  } catch (error) {
    console.error("Error accepting discrepancy:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const declineDiscrepancy = async (req, res) => {
  try {
    const { awbNumber, text } = req.body;

    console.log(`Processing discrepancy decline for AWB: ${awbNumber}`);

    // Validate input
    if (!awbNumber || !text) {
      // console.log("hii")
      return res
        .status(400)
        .json({ message: "AWB Number and reason are required" });
    }

    // Find the discrepancy
    const discrepancy = await WeightDiscrepancy.findOne({ awbNumber });
    if (!discrepancy) {
      return res.status(404).json({ message: "Discrepancy not found" });
    }

    // Update discrepancy status
    Object.assign(discrepancy, {
      status: "new",
      adminStatus: "Discrepancy Declined",
      clientStatus: "Discrepancy Declined",
      discrepancyDeclinedReason: text,
      discrepancyDeclinedAt: new Date(),
    });

    await discrepancy.save();

    return res
      .status(200)
      .json({ message: "Discrepancy declined successfully" });
  } catch (error) {
    console.error("Error declining discrepancy:", error);
    return res.status(500).json({
      message: "An error occurred while declining the discrepancy",
      error: error.message,
    });
  }
};

const bulkDeclineDiscrepancy = async (req, res) => {
  try {
    const { awbNumbers, text } = req.body;

    // Validate input
    if (
      !awbNumbers ||
      !Array.isArray(awbNumbers) ||
      awbNumbers.length === 0 ||
      !text
    ) {
      return res.status(400).json({
        message: "AWB numbers (array) and reason are required",
      });
    }

    console.log(`Processing bulk decline for AWBs: ${awbNumbers.join(", ")}`);

    // Perform bulk update
    const result = await WeightDiscrepancy.updateMany(
      { awbNumber: { $in: awbNumbers } }, // filter multiple documents
      {
        $set: {
          status: "new",
          adminStatus: "Discrepancy Declined",
          clientStatus: "Discrepancy Declined",
          discrepancyDeclinedReason: text,
          discrepancyDeclinedAt: new Date(),
        },
      }
    );

    // Result contains matchedCount and modifiedCount
    res.status(200).json({
      message: `Bulk decline successful. ${result.modifiedCount} discrepancies updated.`,
      result,
    });
  } catch (error) {
    console.error("Error in bulkDeclineDiscrepancy:", error);
    res.status(500).json({
      message: "An error occurred while processing bulk discrepancy decline",
      error: error.message,
    });
  }
};

const exportWeightDiscrepancy = async (req, res) => {
  try {
    const { disputeId } = req.body;
    if (!disputeId || !Array.isArray(disputeId) || disputeId.length === 0) {
      return res.status(400).json({ message: "disputeId array is required" });
    }

    const objectIds = disputeId
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    // Aggregate pipeline
    const pipeline = [
      { $match: { _id: { $in: objectIds } } },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 1,
          userId: "$user.userId", // Use 5-digit userId from users collection
          awbNumber: 1,
          orderId: 1,
          courierServiceName: 1,
          provider: 1,

          // Keep full productDetails array for processing in JS
          productDetails: 1,

          enteredWeightApplicable: "$enteredWeight.applicableWeight",
          chargedWeightApplicable: "$chargedWeight.applicableWeight",

          excessWeight: "$excessWeightCharges.excessWeight",
          excessCharges: "$excessWeightCharges.excessCharges",

          status: 1,
          adminStatus: 1,
          clientStatus: 1,
          createdAt: 1,
          updatedAt: 1,
          text: 1,
          imageUrl: 1,

          user: {
            name: "$user.fullname",
            email: "$user.email",
            phoneNumber: "$user.phoneNumber",
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ];

    const results = await WeightDiscrepancy.aggregate(pipeline);

    if (!results || results.length === 0) {
      return res
        .status(404)
        .json({ message: "No discrepancy data found for given IDs" });
    }

    // Process results for CSV export
    const csvData = results.map((item) => ({
      // DiscrepancyID: item._id.toString(),
      UserID: item.userId || "",
      UserName: item.user.name || "",
      UserEmail: item.user.email || "",
      PhoneNumber: item.user.phoneNumber || "",
      AWBNumber: item.awbNumber || "",
      OrderID: item.orderId || "",
      CourierServiceName: item.courierServiceName || "",
      Provider: item.provider || "",

      // Join product names by comma
      ProductNames: Array.isArray(item.productDetails)
        ? item.productDetails
          .map((pd) => pd.name)
          .filter(Boolean)
          .join(", ")
        : "",

      EnteredWeightApplicable: item.enteredWeightApplicable || "",
      ChargedWeightApplicable: item.chargedWeightApplicable || "",
      ExcessWeight: item.excessWeight || "",
      ExcessCharges: item.excessCharges || "",

      Status: item.status || "",
      // AdminStatus: item.adminStatus || "",
      // ClientStatus: item.clientStatus || "",
      // CreatedAt: item.createdAt ? item.createdAt.toISOString() : "",
      // UpdatedAt: item.updatedAt ? item.updatedAt.toISOString() : "",
      // Text: item.text || "",
      // ImageUrl: item.imageUrl || "",
    }));

    const csvHeaders = Object.keys(csvData[0]);
    const csvContent = [
      csvHeaders.join(","),
      ...csvData.map((row) =>
        csvHeaders
          .map((header) => `"${String(row[header]).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=weight_discrepancy_export.csv"
    );
    return res.send(csvContent);
  } catch (error) {
    console.error("Error exporting weight discrepancy data:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// const checkNonDeliveredDisputes = async () => {
//   try {

//     const discrepancies = await WeightDiscrepancy.find({
//       status: "new",
//     }).select("awbNumber");

//     if (!discrepancies.length) {
//       console.log("No NEW weight discrepancies found.");
//       return;
//     }


//     const awbNumbers = discrepancies.map((d) => d.awbNumber);


//     const orders = await Order.find(
//       { awb_number: { $in: awbNumbers } },
//       { awb_number: 1, status: 1 }
//     );


//     const orderMap = new Map(orders.map((o) => [o.awb_number, o]));


//     let nonDeliveredCount = 0;
//     const nonDeliveredDetails = [];

//     for (const d of discrepancies) {
//       const order = orderMap.get(d.awbNumber);

//       if (!order || order.status === "Not Picked" || order.status==="Booked" || order.status==="Ready To Ship") {
//         nonDeliveredCount++;

//         nonDeliveredDetails.push({
//           awbNumber: d.awbNumber,
//           orderStatus: order?.status || "ORDER_NOT_FOUND",
//         });
//       }
//     }


//     console.log("========== DISPUTE DELIVERY CHECK ==========");
//     console.log(`Total NEW disputes        : ${discrepancies.length}`);
//     console.log(`Not Delivered Disputes    : ${nonDeliveredCount}`);
//     console.log("-------------------------------------------");

//     nonDeliveredDetails.forEach((item, index) => {
//       console.log(
//         `${index + 1}. AWB: ${item.awbNumber} | Status: ${item.orderStatus}`
//       );
//     });

//     console.log("===========================================");
//   } catch (error) {
//     console.error("Error checking dispute delivery status:", error);
//   }
// };


module.exports = {
  downloadExcel,
  uploadDispreancy,
  AllDiscrepancy,
  getAllDiscrepancy,
  AllDiscrepancyBasedId,
  AllDiscrepancyCountBasedId,
  AcceptDiscrepancy,
  AcceptAllDiscrepancies,
  raiseDiscrepancies,
  adminAcceptDiscrepancy,
  declineDiscrepancy,
  bulkDeclineDiscrepancy,
  exportWeightDiscrepancy,
};
