const mongoose = require("mongoose");
const cron = require("node-cron");
const CodPlan = require("./codPan.model");
const codRemittance = require("./codRemittance.model");
const Order = require("../models/newOrder.model");
const adminCodRemittance = require("./adminCodRemittance.model");
const users = require("../models/User.model");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const afterPlan = require("./afterPlan.model");
const fs = require("fs");
const csvParser = require("csv-parser");
const User = require("../models/User.model.js");
const ExcelJS = require("exceljs");
const path = require("path");
const xlsx = require("xlsx");
const File = require("../model/bulkOrderFiles.model.js");
const AllocateRole = require("../models/allocateRoleSchema");
const bankAccount = require("../models/BankAccount.model.js");

// const { date } = require("joi");
const CourierCodRemittance = require("./CourierCodRemittance.js");
const CodRemittanceOrdersModel = require("./CodRemittanceOrder.model.js");
const SameDateDelivered = require("./samedateDelivery.model.js");
const BankAccountDetails = require("../models/BankAccount.model.js");
const BankExportBatch = require("../models/BankExportBatch.model.js");
const codPlanUpdate = async (req, res) => {
  try {
    const { id } = req.query;
    const userID = id || req.user?._id; // Ensure req.user exists
    const { planName, codAmount } = req.body;

    // console.log("Request Body:", req.body); // Debugging log

    // Validate user authentication
    if (!userID) {
      return res.status(401).json({
        success: false,
        error: "User not authenticated",
      });
    }

    // Validate request body
    if (!planName || !codAmount) {
      return res.status(400).json({
        success: false,
        error: "Plan name and COD amount are required",
      });
    }

    // Find existing COD Plan for the user
    let codPlan = await CodPlan.findOne({ user: userID });

    if (codPlan) {
      // Update existing COD Plan
      codPlan.planName = planName;
      codPlan.planCharges = codAmount;
      codPlan.isCustom = false;
      codPlan.remittanceDay = undefined;
      await codPlan.save();

      return res.status(200).json({
        success: true,
        message: "COD Plan updated successfully",
        codPlan,
      });
    } else {
      // Create new COD Plan
      codPlan = new CodPlan({
        user: userID,
        planName,
        planCharges: codAmount,
      });
      await codPlan.save();

      return res.status(201).json({
        success: true,
        message: "New COD Plan created successfully",
        codPlan,
      });
    }
  } catch (error) {
    console.error("Error updating COD Plan:", error); // Log for debugging

    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the COD Plan",
      error: error.message,
    });
  }
};

const runTransaction = async (callback) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await callback(session);
    await session.commitTransaction();
    session.endSession();
    return result;
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

const codToBeRemitteds = async () => {
  const session = await mongoose.startSession();

  try {
    const daysBack = 20;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    const deliveredCodOrders = await Order.aggregate([
      {
        $match: {
          status: "Delivered",
          "paymentDetails.method": "COD",
          codProcessed: { $ne: true },
        },
      },
      {
        $project: {
          tracking: 1,
          paymentDetails: 1,
          orderId: 1,
          awb_number: 1,
          userId: 1,
          lastTracking: { $arrayElemAt: ["$tracking", -1] },
        },
      },
      {
        $match: {
          "lastTracking.StatusDateTime": { $gte: cutoffDate },
        },
      },
    ]);

    console.log(`🚚 Found ${deliveredCodOrders.length} COD orders.`);

    // Pre-fetch all remittances and afterPlans for the unique users to avoid N+1 queries
    const uniqueUserIds = [...new Set(deliveredCodOrders.filter((o) => o.userId).map((o) => o.userId.toString()))];
    const [allRemittances, allAfterPlans] = await Promise.all([
      codRemittance.find({ userId: { $in: uniqueUserIds } }).lean(),
      afterPlan.find({ userId: { $in: uniqueUserIds } }).lean(),
    ]);

    const remittanceMap = new Map(
      allRemittances.filter((r) => r.userId).map((r) => [r.userId.toString(), r])
    );
    const afterPlanMap = new Map();
    for (const p of allAfterPlans) {
      if (p.userId) {
        const uid = p.userId.toString();
        if (!afterPlanMap.has(uid)) afterPlanMap.set(uid, []);
        afterPlanMap.get(uid).push(p);
      }
    }

    for (const order of deliveredCodOrders) {
      const deliveryDate = order.lastTracking?.StatusDateTime;

      if (!deliveryDate) {
        console.log(`⚠ Skipped: No delivery date for order ${order._id}`);
        continue;
      }

      if (!order.userId) {
        console.log(`⚠ Skipped: No userId for order ${order._id}`);
        continue;
      }

      // Normalize date using IST day boundaries
      const IST_OFFSET = 5.5 * 60 * 60 * 1000;
      const deliveryDateObj = new Date(deliveryDate);
      const istDateStr = new Date(deliveryDateObj.getTime() + IST_OFFSET).toISOString().split("T")[0];
      const startOfDay = new Date(new Date(`${istDateStr}T00:00:00.000Z`).getTime() - IST_OFFSET);
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

      const codAmount = order.paymentDetails.amount || 0;
      const customOrderId = String(order.orderId || "");

      // 🔥 Start TRANSACTION
      await session.withTransaction(async () => {
        // 1️⃣ Fetch or create SameDateDelivered atomically
        let sameDateEntry = await SameDateDelivered.findOneAndUpdate(
          {
            userId: order.userId,
            deliveryDate: { $gte: startOfDay, $lte: endOfDay },
          },
          {
            $setOnInsert: {
              userId: order.userId,
              deliveryDate: new Date(deliveryDate),
              orderDetails: [],
              orderIds: [],
              totalCod: 0,
              status: "Pending",
            },
          },
          { upsert: true, new: true, session }
        );

        // 2️⃣ Prevent duplicate orders (Global check across all SameDateDelivered documents for the user)
        const globalDuplicate = await SameDateDelivered.findOne({
          userId: order.userId,
          orderIds: order._id
        }).session(session);

        if (globalDuplicate) {
          if (globalDuplicate.status === "Completed") {
            const userRemittance = remittanceMap.get(order.userId.toString());
            const userAfterPlans = afterPlanMap.get(order.userId.toString()) || [];

            const alreadyRemittedOrderIds = new Set(
              userRemittance?.remittanceData?.flatMap((r) => r.orderDetails?.orders?.map((id) => id.toString()) || []) || []
            );
            const alreadyInAfterPlanOrderIds = new Set(
              userAfterPlans.flatMap((p) => p.orderDetails?.orders?.map((id) => id.toString()) || [])
            );

            if (!alreadyRemittedOrderIds.has(order._id.toString()) && !alreadyInAfterPlanOrderIds.has(order._id.toString())) {
              console.log(`♻️ Stranded order detected: ${order.orderId}. Resetting SameDateDelivered to Pending.`);
              await SameDateDelivered.updateOne(
                { _id: globalDuplicate._id },
                { $set: { status: "Pending" } },
                { session }
              );
            }
          }
          console.log(`⛔ Duplicate order ignored (already exists globally): ${order.orderId}`);
          return; // nothing to update
        }

        // 3️⃣ Push new order details
        await SameDateDelivered.updateOne(
          { _id: sameDateEntry._id },
          {
            $push: {
              orderDetails: {
                orderId: order._id,
                codAmount,
                customOrderId,
              },
              orderIds: order._id,
            },
            $inc: { totalCod: codAmount },
            $set: { status: "Pending" }, // Reset status to Pending to ensure late deliveries are processed
          },
          { session }
        );

        // 4️⃣ Update CODToBeRemitted atomically
        await codRemittance.updateOne(
          { userId: order.userId },
          {
            $inc: { CODToBeRemitted: codAmount },
            $setOnInsert: { rechargeAmount: 0, userId: order.userId },
          },
          { upsert: true, session }
        );
      });

      // END TRANSACTION
      console.log(`✔ Updated COD for order ${order.orderId}`);
    }
  } catch (error) {
    console.error("❌ CODToBeRemitteds ERROR:", error);
  } finally {
    session.endSession();
  }
};

if (process.env.NODE_ENV === "production") {
  cron.schedule("1 1 * * *", () => {
    console.log(
      "⏰ Running scheduled task at 1:01 AM (production): Fetching orders..."
    );
    codToBeRemitteds();
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
} else {
  console.log("⚙️ Cron job not started (development mode)");
}
// codToBeRemitteds();

const getStartOfDayIST = (date = new Date()) => {
  const istTime = new Date(date.getTime() + (5.5 * 3600 * 1000));
  istTime.setUTCHours(0, 0, 0, 0);
  return new Date(istTime.getTime() - (5.5 * 3600 * 1000));
};

const remittanceScheduleData = async () => {
  try {
    const todayIST = new Date();
    const [existingSameDateDelivered, afterCodPlans] = await Promise.all([
      SameDateDelivered.find({ status: "Pending" }),
      afterPlan.find(),
    ]);

    console.log(
      `Found ${existingSameDateDelivered.length} pending SameDateDelivered entries and ${afterCodPlans.length} afterPlan entries.`
    );

    const startOfTodayIST = getStartOfDayIST(new Date());
    
    // Get the current day name and index in Asia/Kolkata timezone reliably
    const todayDayName = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "long"
    }).format(new Date()); // e.g., "Friday"

    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const day = DAY_NAMES.indexOf(todayDayName);
    const isTodayMWF = [1, 3, 5].includes(day); // Mon, Wed, Fri

    // Gather all unique user IDs
    const allUserIds = new Set();
    existingSameDateDelivered.forEach((e) => allUserIds.add(e.userId.toString()));
    afterCodPlans.forEach((p) => allUserIds.add(p.userId.toString()));

    for (const userId of allUserIds) {
      const [codPlan, user] = await Promise.all([
        CodPlan.findOne({ user: userId }),
        User.findById(userId),
      ]);

      if (!codPlan || !codPlan.planName) {
        console.log(`No plan for user ${userId}. Assigning default D+7 plan.`);
        await new CodPlan({ user: userId, planName: "D+7" }).save();
        continue; // entries stay "Pending" or outstanding — retried next night
      }

      const planDays = parseInt(codPlan.planName.replace(/\D/g, ""), 10);

      // Process new SameDateDelivered entries for this user
      const userSameDateEntries = existingSameDateDelivered.filter(
        (e) => e.userId.toString() === userId
      );
      const eligibleSameDate = [];
      const deferredSameDate = [];

      for (const remittance of userSameDateEntries) {
        const deliveryDate = remittance.deliveryDate;
        const startOfOrderIST = getStartOfDayIST(deliveryDate);
        const dayDiff = Math.round((startOfTodayIST.getTime() - startOfOrderIST.getTime()) / (1000 * 60 * 60 * 24));

        const shouldRemitToday = codPlan.isCustom
          ? ((Array.isArray(codPlan.remittanceDay)
            ? codPlan.remittanceDay.includes(todayDayName)
            : codPlan.remittanceDay === todayDayName) && dayDiff > planDays)
          : (isTodayMWF && dayDiff > planDays);

        if (shouldRemitToday) {
          eligibleSameDate.push(remittance);
        } else {
          deferredSameDate.push(remittance);
        }
      }

      // Process existing deferred afterPlan entries for this user
      const userAfterPlanEntries = afterCodPlans.filter(
        (p) => p.userId.toString() === userId
      );
      const eligibleAfterPlan = [];

      for (const plan of userAfterPlanEntries) {
        const deliveryDate =
          plan.deliveryDate ||
          (plan.orderDetails?.date ? new Date(plan.orderDetails.date) : new Date());

        const startOfOrderIST = getStartOfDayIST(deliveryDate);
        const dayDiff = Math.round((startOfTodayIST.getTime() - startOfOrderIST.getTime()) / (1000 * 60 * 60 * 24));

        const shouldMoveToAdmin = codPlan.isCustom
          ? ((Array.isArray(codPlan.remittanceDay)
            ? codPlan.remittanceDay.includes(todayDayName)
            : codPlan.remittanceDay === todayDayName) && dayDiff > planDays)
          : (isTodayMWF && dayDiff > planDays);

        if (shouldMoveToAdmin) {
          eligibleAfterPlan.push(plan);
        }
      }

      // Execute database operations in a single consolidated transaction per user
      await runTransaction(async (session) => {
        // 1. Save new deferred entries to afterPlan and mark SameDateDelivered as Completed
        if (deferredSameDate.length > 0) {
          const userRemittance = await codRemittance.findOne({ userId }).session(session);
          const alreadyRemittedOrderIds = new Set(
            userRemittance?.remittanceData?.flatMap((r) => r.orderDetails?.orders?.filter(Boolean).map((id) => id.toString()) || []) || []
          );
          const existingAfterPlanOrderIds = new Set(
            userAfterPlanEntries.flatMap((p) => p.orderDetails?.orders?.filter(Boolean).map((id) => id.toString()) || [])
          );

          const remittanceEntries = [];
          for (const remittance of deferredSameDate) {
            const filteredOrderIds = remittance.orderIds.filter(
              (id) => id && !existingAfterPlanOrderIds.has(id.toString()) && !alreadyRemittedOrderIds.has(id.toString())
            );

            if (filteredOrderIds.length > 0) {
              const actualOrders = await Order.find({ _id: { $in: filteredOrderIds } }).session(session).lean().select("paymentDetails");
              const filteredTotalCod = Number(
                actualOrders.reduce((sum, o) => sum + Number(o.paymentDetails?.amount || 0), 0).toFixed(2)
              );

              remittanceEntries.push({
                date: todayIST,
                userId: remittance.userId,
                userName: user ? user.fullname : "",
                totalCod: filteredTotalCod,
                orderDetails: {
                  date: todayIST,
                  codcal: filteredTotalCod,
                  orders: filteredOrderIds,
                },
                deliveryDate: remittance.deliveryDate,
                status: "Pending",
                planName: codPlan.planName,
                planDays: planDays,
              });
            }
          }

          if (remittanceEntries.length > 0) {
            await afterPlan.create(remittanceEntries, { session });
          }
          await SameDateDelivered.updateMany(
            { _id: { $in: deferredSameDate.map((e) => e._id) } },
            { $set: { status: "Completed" } },
            { session }
          );
        }

        // 2. Process all eligible entries (SameDateDelivered + afterPlan)
        if (eligibleSameDate.length > 0 || eligibleAfterPlan.length > 0) {
          const rawOrderIds = [
            ...eligibleSameDate.flatMap((e) => [...e.orderIds]),
            ...eligibleAfterPlan.flatMap((p) => p.orderDetails?.orders || []),
          ];

          // Deduplicate order IDs in memory
          const uniqueOrderIds = [...new Set(rawOrderIds.filter(Boolean).map((id) => id.toString()))];

          // Fetch user's existing remittance entries to avoid duplicate processing
          const userRemittance = await codRemittance.findOne({ userId }).session(session);
          const alreadyRemittedOrderIds = new Set(
            userRemittance?.remittanceData?.flatMap((r) => r.orderDetails?.orders?.filter(Boolean).map((id) => id.toString()) || []) || []
          );

          const existingAfterPlanOrderIds = new Set(
            userAfterPlanEntries.flatMap((p) => p.orderDetails?.orders?.filter(Boolean).map((id) => id.toString()) || [])
          );
          const eligibleAfterPlanOrderIds = new Set(
            eligibleAfterPlan.flatMap((p) => p.orderDetails?.orders?.filter(Boolean).map((id) => id.toString()) || [])
          );
          // Non-eligible afterPlan order IDs: those that are in existingAfterPlanOrderIds but NOT in eligibleAfterPlanOrderIds
          const nonEligibleAfterPlanOrderIds = new Set(
            [...existingAfterPlanOrderIds].filter((id) => !eligibleAfterPlanOrderIds.has(id))
          );

          // Filter out already processed/remitted order IDs and non-eligible afterPlan order IDs
          const nonRemittedOrderIds = uniqueOrderIds.filter(
            (id) => !alreadyRemittedOrderIds.has(id) && !nonEligibleAfterPlanOrderIds.has(id)
          );

          let finalOrderIds = [];
          let aggregatedTotalCod = 0;

          if (nonRemittedOrderIds.length > 0) {
            const actualOrders = await Order.find({ _id: { $in: nonRemittedOrderIds } }).session(session).lean().select("paymentDetails");
            finalOrderIds = actualOrders.map((o) => o._id);
            aggregatedTotalCod = Number(
              actualOrders.reduce((sum, o) => sum + Number(o.paymentDetails?.amount || 0), 0).toFixed(2)
            );
          }

          if (finalOrderIds.length > 0) {
            const earliestSameDate = eligibleSameDate.reduce(
              (earliest, e) => (!earliest || e.deliveryDate < earliest ? e.deliveryDate : earliest),
              null
            );
            const earliestAfterPlanDate = eligibleAfterPlan.reduce((earliest, p) => {
              const d = p.deliveryDate || (p.orderDetails?.date ? new Date(p.orderDetails.date) : todayIST);
              return !earliest || d < earliest ? d : earliest;
            }, null);

            let earliestDeliveryDate = earliestSameDate;
            if (
              earliestAfterPlanDate &&
              (!earliestDeliveryDate || earliestAfterPlanDate < earliestDeliveryDate)
            ) {
              earliestDeliveryDate = earliestAfterPlanDate;
            }

            const aggregatedPlan = {
              date: todayIST,
              userId: userId,
              userName: user ? user.fullname : "",
              totalCod: aggregatedTotalCod,
              orderDetails: {
                date: todayIST,
                codcal: aggregatedTotalCod,
                orders: finalOrderIds,
              },
              deliveryDate: earliestDeliveryDate || todayIST,
              status: "Pending",
              planName: codPlan.planName,
              planDays: planDays,
            };

            // This generates exactly ONE remittance ID and performs adjustments
            await processAndRemit(aggregatedPlan, session);
          } else {
            console.log(`⚠️ All eligible order IDs for user ${userId} were already remitted or invalid. Skipping remittance creation.`);
          }

          // Mark processed SameDateDelivered as Completed
          if (eligibleSameDate.length > 0) {
            await SameDateDelivered.updateMany(
              { _id: { $in: eligibleSameDate.map((e) => e._id) } },
              { $set: { status: "Completed" } },
              { session }
            );
          }

          // Delete processed afterPlan entries
          if (eligibleAfterPlan.length > 0) {
            await afterPlan.deleteMany(
              { _id: { $in: eligibleAfterPlan.map((p) => p._id) } },
              { session }
            );
          }
        }
      });

      if (eligibleSameDate.length > 0 || eligibleAfterPlan.length > 0) {
        console.log(
          `✅ Aggregated ${eligibleSameDate.length} new and ${eligibleAfterPlan.length} deferred entries for user ${userId} into one remittanceId`
        );
      }
    }
  } catch (error) {
    console.error("❌ Error in remittance schedule:", error);
  }
};

if (process.env.NODE_ENV === "production") {
  cron.schedule(
    "45 1 * * *",
    () => {
      console.log(
        "⏰ Running scheduled task at 1:45 AM IST (production): Fetching orders..."
      );
      remittanceScheduleData();
    },
    {
      scheduled: true,
      timezone: "Asia/Kolkata",
    }
  );
} else {
  console.log("⚙️ Cron job not started (development/local environment)");
}

// remittanceScheduleData();

// Helper for direct business logic (used in both controllers)
const processAndRemit = async (plan, session) => {
  const todayIST = new Date();
  // Generate remittanceId here — only at actual remittance time, not when queued
  let remitanceId;
  do {
    remitanceId = Math.floor(10000 + Math.random() * 90000);
  } while (await adminCodRemittance.findOne({ remitanceId }));

  // Fetch fresh user, codPlan, wallet, codRemittance:
  const [user, codPlan, remittanceData] = await Promise.all([
    User.findById(plan.userId),
    CodPlan.findOne({ user: plan.userId }),
    codRemittance.findOne({ userId: plan.userId }),
  ]);

  if (!user || !codPlan || !remittanceData) {
    console.log(`Missing data for user ${plan.userId}, skipping...`);
    return;
  }

  // Now fetch the wallet using the user's wallet reference
  const wallet = await Wallet.findById(user.Wallet).select("balance");

  if (!wallet) {
    console.log(`Missing wallet for user ${plan.userId}, skipping...`);
    return;
  }

  const rawOrderIds = plan.orderDetails?.orders || [];
  if (rawOrderIds.length === 0) {
    console.log("No orders to remit, skipping...");
    return;
  }

  // Find any order IDs that are already remitted globally in adminCodRemittance
  const objectIds = rawOrderIds.filter(Boolean).map(id => new mongoose.Types.ObjectId(id));
  const duplicateAdminRecords = await adminCodRemittance.find({
    "orderDetails.orders": { $in: objectIds }
  }).session(session).lean().select("orderDetails.orders");

  const globallyRemittedIds = new Set();
  duplicateAdminRecords.forEach(rec => {
    rec.orderDetails?.orders?.forEach(id => {
      globallyRemittedIds.add(id.toString());
    });
  });

  // Filter out globally remitted order IDs
  const cleanOrderIds = rawOrderIds.filter(id => {
    const idStr = id.toString();
    if (globallyRemittedIds.has(idStr)) {
      console.warn(`🚨 Skipping duplicate order ID during processAndRemit: ${idStr}`);
      return false;
    }
    return true;
  });

  if (cleanOrderIds.length === 0) {
    console.log("All orders in this plan were already remitted globally. Skipping processAndRemit.");
    return;
  }

  // Fetch the clean orders to calculate the correct totalCod
  const actualOrders = await Order.find({ _id: { $in: cleanOrderIds } }).session(session).lean().select("paymentDetails");
  const calculatedTotalCod = Number(
    actualOrders.reduce((sum, o) => sum + Number(o.paymentDetails?.amount || 0), 0).toFixed(2)
  );

  // Update the plan object with clean orders and recalculated totalCod
  plan.orderDetails.orders = cleanOrderIds;
  plan.totalCod = calculatedTotalCod;
  plan.orderDetails.codcal = calculatedTotalCod;

  const planDays = parseInt(codPlan.planName.replace(/\D/g, ""), 10);
  const planCharges = codPlan.planCharges || 0;
  const deliveryDate =
    plan.deliveryDate ||
    (plan.orderDetails?.date ? new Date(plan.orderDetails.date) : new Date());
  const startOfTodayIST = getStartOfDayIST(new Date());
  const startOfOrderIST = getStartOfDayIST(deliveryDate);
  const dayDiff = Math.round(
    (startOfTodayIST.getTime() - startOfOrderIST.getTime()) / (1000 * 60 * 60 * 24)
  );

  // CodRemittance logic as per your initial approach
  // We'll use totalCod from the raw plan for calculation
  let rechargeAmount = remittanceData.rechargeAmount || 0;
  let extraAmount = 0,
    remainingRecharge = 0;
  let creditedAmount = 0,
    afterWallet = wallet.balance;
  const totalCod = plan.totalCod || 0;

  if (rechargeAmount <= totalCod) {
    remainingRecharge = totalCod - rechargeAmount;
    extraAmount = rechargeAmount;
    rechargeAmount = 0;
  } else {
    rechargeAmount -= totalCod;
    extraAmount = totalCod;
    remainingRecharge = 0;
  }

  // Deduction/adjustment logic
  if (wallet.balance < 0) {
    const adjustAmount = Math.min(remainingRecharge, Math.abs(wallet.balance));
    if (adjustAmount > 0) {
      creditedAmount = adjustAmount;
      remainingRecharge -= adjustAmount;
      afterWallet += adjustAmount;

      // ✅ Create transaction only when adjustment happens
      const transactionEntry = {
        channelOrderId: "" || null,
        category: "credit",
        amount: creditedAmount,
        balanceAfterTransaction: afterWallet,
        awb_number: "" || null,
        description: "COD Adjustment credited to wallet",
      };

      await Wallet.updateOne(
        { _id: wallet._id },
        {
          $set: { balance: afterWallet },
        },
        { session }
      );

      await WalletTransaction.create([
        {
          walletId: wallet._id,
          channelOrderId: transactionEntry.channelOrderId,
          category: transactionEntry.category,
          amount: transactionEntry.amount,
          balanceAfterTransaction: transactionEntry.balanceAfterTransaction,
          awb_number: transactionEntry.awb_number,
          description: transactionEntry.description,
        }
      ], { session });
    } else {
      // adjustAmount is 0 → only update balance
      await Wallet.updateOne(
        { _id: wallet._id },
        { $set: { balance: afterWallet } },
        { session }
      );
    }
  } else {
    // No adjustment → only update balance
    await Wallet.updateOne(
      { _id: wallet._id },
      { $set: { balance: afterWallet } },
      { session }
    );
  }

  // Charges
  const charges = Number(((remainingRecharge * planCharges) / 100).toFixed(2));
  const TotalDeduction = Number(
    (charges + creditedAmount + extraAmount).toFixed(2)
  );
  const codToBeRemitted = Number(remittanceData.CODToBeRemitted);
  const totalCodConsumed = Number(
    (remainingRecharge + creditedAmount).toFixed(2)
  );
  const codToBeDeducted = totalCodConsumed;

  // Prepare remittance entry
  const totalCodResult = Number((remainingRecharge - charges).toFixed(2));
  const remittanceEntryForUser = {
    date: todayIST,
    remittanceId: remitanceId,
    codAvailable: Number(totalCodResult.toFixed(2)),
    amountCreditedToWallet: extraAmount,
    adjustedAmount: creditedAmount,
    earlyCodCharges: Number(charges.toFixed(2)),
    status: totalCodResult === 0 ? "Paid" : "Pending",
    orderDetails: plan.orderDetails,
  };
  // Actual payout to client (deduct charges here)
  const payoutToClient = Number((remainingRecharge - charges).toFixed(2));

  // Update codRemittance
  const updatedRem = await codRemittance.findOneAndUpdate(
    { userId: plan.userId, CODToBeRemitted: { $gte: codToBeDeducted } }, // ensure enough COD
    {
      $inc: {
        CODToBeRemitted: -totalCodConsumed,
        RemittanceInitiated: payoutToClient,
        TotalDeductionfromCOD: TotalDeduction,
      },
      $set: { rechargeAmount },
      $push: { remittanceData: remittanceEntryForUser },
    },
    { new: true, session }
  );

  if (!updatedRem) {
    console.error(`❌ Insufficient CODToBeRemitted for user ${plan.userId}. Rolling back transaction (wallet credit + COD deduction).`);
    throw new Error(`Insufficient CODToBeRemitted for user ${plan.userId}`);
  }

  const adminEntry = {
    date: todayIST,
    userId: plan.userId,
    userName: user.fullname,
    remitanceId: remitanceId,
    totalCod: Number(totalCodResult.toFixed(2)),
    amountCreditedToWallet: extraAmount,
    adjustedAmount: creditedAmount,
    earlyCodCharges: Number(charges.toFixed(2)),
    status: totalCodResult === 0 ? "Paid" : "Pending",
    orderDetails: plan.orderDetails,
  };

  // Save to adminCodRemittance
  await new adminCodRemittance(adminEntry).save({ session });

  // Mark all remitted orders as codProcessed: true
  if (plan.orderDetails?.orders) {
    const orderIds = plan.orderDetails.orders.filter(Boolean);
    if (orderIds.length > 0) {
      await Order.updateMany(
        { _id: { $in: orderIds } },
        { $set: { codProcessed: true } },
        { session }
      );
    }
  }

  // Sync corresponding orders status to Paid in CodRemittanceOrdersModel if the remittance is Paid immediately
  if (adminEntry.status === "Paid" && plan.orderDetails?.orders) {
    const orderIds = plan.orderDetails.orders.filter(Boolean);
    if (orderIds.length > 0) {
      const orders = await Order.find({ _id: { $in: orderIds } }).session(session).lean().select("orderId awb_number");
      const customOrderIds = orders.map(o => String(o.orderId)).filter(Boolean);
      const awbs = orders.map(o => String(o.awb_number)).filter(Boolean);

      if (customOrderIds.length > 0 || awbs.length > 0) {
        await CodRemittanceOrdersModel.updateMany(
          {
            $or: [
              { orderID: { $in: customOrderIds } },
              { AWB_Number: { $in: awbs } }
            ]
          },
          { $set: { status: "Paid" } },
          { session }
        );
      }
    }
  }
};

const fetchExtraData = async () => {
  try {
    const todayIST = new Date();
    
    // Get the current day name and index in Asia/Kolkata timezone reliably
    const todayDayName = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "long"
    }).format(new Date()); // e.g., "Friday"

    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const day = DAY_NAMES.indexOf(todayDayName);
    const isTodayMWF = [1, 3, 5].includes(day); // Mon, Wed, Fri

    const afterCodPlans = await afterPlan.find();

    // Group by userId so all deferred delivery dates are combined into ONE remittanceId
    const byUser = {};
    for (const plan of afterCodPlans) {
      const uid = plan.userId.toString();
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(plan);
    }

    for (const [userId, plans] of Object.entries(byUser)) {
      const codPlan = await CodPlan.findOne({ user: userId });
      if (!codPlan || !codPlan.planName) {
        console.log(`⛔ Skipping: No COD plan for user ${userId}`);
        continue;
      }

      const planDays = parseInt(codPlan.planName.replace(/\D/g, ""), 10);
      const eligiblePlans = [];

      for (const plan of plans) {
        const deliveryDate =
          plan.deliveryDate ||
          (plan.orderDetails?.date ? new Date(plan.orderDetails.date) : todayIST);

        const startOfTodayIST = getStartOfDayIST(new Date());
        const startOfOrderIST = getStartOfDayIST(deliveryDate);
        const dayDiff = Math.round((startOfTodayIST.getTime() - startOfOrderIST.getTime()) / (1000 * 60 * 60 * 24));

        const shouldMoveToAdmin = codPlan.isCustom
          ? ((Array.isArray(codPlan.remittanceDay)
            ? codPlan.remittanceDay.includes(todayDayName)
            : codPlan.remittanceDay === todayDayName) && dayDiff > planDays)
          : (isTodayMWF && dayDiff > planDays);

        if (shouldMoveToAdmin) {
          eligiblePlans.push(plan);
        } else {
          console.log(`⏭️ Skipping user ${userId}: Not yet due (dayDiff: ${dayDiff})`);
        }
      }

      if (eligiblePlans.length === 0) continue;

      // Aggregate all eligible afterPlan entries for this user → ONE remittanceId
      const aggregatedTotalCod = eligiblePlans.reduce((sum, p) => sum + (p.totalCod || 0), 0);
      const aggregatedOrderIds = eligiblePlans.flatMap((p) => p.orderDetails?.orders || []);
      const earliestDeliveryDate = eligiblePlans.reduce((earliest, p) => {
        const d = p.deliveryDate || (p.orderDetails?.date ? new Date(p.orderDetails.date) : todayIST);
        return !earliest || d < earliest ? d : earliest;
      }, null);

      const aggregatedPlan = {
        userId: eligiblePlans[0].userId,
        totalCod: aggregatedTotalCod,
        orderDetails: {
          date: todayIST,
          codcal: aggregatedTotalCod,
          orders: aggregatedOrderIds,
        },
        deliveryDate: earliestDeliveryDate || todayIST,
      };

      await runTransaction(async (session) => {
        await processAndRemit(aggregatedPlan, session);
        await afterPlan.deleteMany(
          { _id: { $in: eligiblePlans.map((p) => p._id) } },
          { session }
        );
      });

      console.log(`✅ Aggregated ${eligiblePlans.length} afterPlan entries for user ${userId} into one remittanceId`);
    }
  } catch (error) {
    console.error("❌ Error in fetchExtraData:", error.message);
  }
};

// NOTE: fetchExtraData cron job has been deactivated because its logic is now consolidated
// into remittanceScheduleData to ensure exactly ONE remittance ID is created per user per remittance day.
//
// if (process.env.NODE_ENV === "production") {
//   cron.schedule(
//     "25 2 * * *",
//     () => {
//       console.log(
//         "⏰ Running scheduled task at 2:25 AM IST (production): Migrating afterPlan with recalculation..."
//       );
//       fetchExtraData();
//     },
//     {
//       scheduled: true,
//       timezone: "Asia/Kolkata",
//     }
//   );
// } else {
//   console.log("⚙️ Cron job not started (development/local environment)");
// }
// fetchExtraData();

const codRemittanceData = async (req, res) => {
  try {
    const {
      id,
      fromDate,
      toDate,
      remittanceIdFilter,
      utrFilter,
      statusFilter,
    } = req.query;

    const page = Number(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      !limitQuery || limitQuery === "All" ? null : Number(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const userId = id || req.user._id;

    const remittanceDoc = await codRemittance.findOne({ userId }).lean();
    if (!remittanceDoc) {
      return res.status(404).json({
        success: false,
        message: "No remittance data found for this user",
      });
    }

    // ---- Apply filters only on remittanceData ----
    let rows = Array.isArray(remittanceDoc.remittanceData)
      ? remittanceDoc.remittanceData
      : [];

    if (remittanceIdFilter) {
      const terms = remittanceIdFilter.split(",").map((s) => s.trim());
      rows = rows.filter((e) =>
        terms.some((t) => String(e.remittanceId || "").includes(t))
      );
    }

    if (utrFilter) {
      const terms = utrFilter.split(",").map((s) => s.trim());
      rows = rows.filter((e) =>
        terms.some((t) => String(e.utr || "").includes(t))
      );
    }

    if (statusFilter) {
      rows = rows.filter((e) => e.status === statusFilter.trim());
    }

    if (fromDate && toDate) {
      const start = new Date(fromDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      rows = rows.filter((e) => {
        const d = new Date(e.date);
        return d >= start && d <= end;
      });
    }

    // ---- Sort newest first ----
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    // ---- Pagination ----
    const totalCount = rows.length;
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;
    const paginated = limit ? rows.slice(skip, skip + limit) : rows;

    return res.status(200).json({
      success: true,
      message: "COD remittance data retrieved successfully",
      total: totalCount,
      page,
      limit: limit || "All",
      totalPages,
      data: {
        // ✅ Take directly from DB document
        TotalCODRemitted: Number(remittanceDoc.TotalCODRemitted || 0),
        TotalDeductionfromCOD: Number(remittanceDoc.TotalDeductionfromCOD || 0),
        RemittanceInitiated: Number(remittanceDoc.RemittanceInitiated || 0),
        CODToBeRemitted: Number(remittanceDoc.CODToBeRemitted || 0),
        LastCODRemitted: Number(remittanceDoc.LastCODRemitted || 0),
        rechargeAmount: Number(remittanceDoc.rechargeAmount || 0),

        // Only filtered + paginated rows
        remittanceData: paginated,
      },
    });
  } catch (error) {
    console.error("Error fetching COD remittance data:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving COD remittance data",
      error: error.message,
    });
  }
};

const getCodRemitance = async (req, res) => {
  try {
    const user = req.user._id;
    const remittanceRecord = await codRemittance.findOne({ userId: user });
    if (!remittanceRecord) {
      return res
        .status(404)
        .json({ message: "No COD remittance record found." });
    }

    return res.status(200).json({
      remittance: remittanceRecord.CODToBeRemitted,
    });
  } catch (error) {
    console.error("Error fetching COD remittance:", error);
    return res
      .status(500)
      .json({ message: "Failed to retrieve COD remittance data." });
  }
};

const codRemittanceRecharge = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const userId = req.user._id;
    const { amount, walletId } = req.body;

    // Validate amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "Invalid recharge amount" });
    }

    // ✅ Find user correctly
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // ✅ Fetch all COD orders for this user (Pending)
    const allCodRemittanceOrder = await CodRemittanceOrdersModel.find({
      Email: user.email,
      status: "Pending",
    }).sort({ Date: 1 }); // optional: sort oldest first

    const remittanceRecord = await codRemittance.findOne({ userId }).lean();
    if (!remittanceRecord) {
      return res.status(404).json({ message: "Remittance record not found" });
    }

    // Calculate actual pending COD available from remittanceData
    const pendingCodAvailable = Array.isArray(remittanceRecord.remittanceData)
      ? remittanceRecord.remittanceData
        .filter((r) => r.status === "Pending")
        .reduce((sum, r) => sum + Number(r.codAvailable || 0), 0)
      : 0;

    // Determine the lower value between RemittanceInitiated and pendingCodAvailable
    const effectivePending = Math.min(
      Number(remittanceRecord.RemittanceInitiated || 0),
      pendingCodAvailable
    );

    // Check if requested recharge exceeds effective pending amount
    if (amount > remittanceRecord.CODToBeRemitted) {
      return res.status(400).json({
        message: "Insufficient COD Available Balance",
        available: effectivePending,
      });
    }

    const currentWallet = await Wallet.findById(walletId).select("balance");
    if (!currentWallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    session.startTransaction();

    // ✅ Deduct amount against COD Orders
    let remainingAmount = amount;
    let fulfilledOrders = [];

    for (const order of allCodRemittanceOrder) {
      let codValue = Number(order.CODAmount);

      if (remainingAmount >= codValue) {
        // Full payment for this order
        await CodRemittanceOrdersModel.updateOne(
          { _id: order._id },
          { $set: { status: "Paid" } },
          { session }
        );
        fulfilledOrders.push(order.orderID);
        remainingAmount -= codValue;
      } else if (remainingAmount > 0) {
        // Partial payment
        const newValue = codValue - remainingAmount;

        await CodRemittanceOrdersModel.updateOne(
          { _id: order._id },
          { $set: { CODAmount: newValue } },
          { session }
        );
        remainingAmount = 0;
        break;
      }
      if (remainingAmount <= 0) break;
    }

    // ✅ Update remittance record
    await codRemittance.updateOne(
      { _id: remittanceRecord._id },
      {
        $inc: {
          CODToBeRemitted: -amount,
          rechargeAmount: amount,
          // RemittanceInitiated: -amount,
        },
      },
      { session }
    );

    // ✅ Push transaction and update wallet balance
    await Promise.all([
      currentWallet.updateOne({
        $inc: { balance: amount },
      }, { session }),
      WalletTransaction.create([{
        walletId: currentWallet._id,
        category: "credit",
        amount,
        balanceAfterTransaction: currentWallet.balance + amount,
        date: new Date(),
        description: "Recharge from COD Remittance",
      }], { session })
    ]);

    await session.commitTransaction();

    return res.status(200).json({
      success: true,
      message: "COD remittance recharge processed successfully.",
      rechargedAmount: amount,
      fulfilledOrders,
      remainingBalance: remainingAmount,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error processing COD remittance recharge:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to process COD remittance recharge.",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

const downloadSampleExcel = async (req, res) => {
  try {
    // Create a new workbook and add a worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sample Bulk Order");

    // Define headers
    worksheet.columns = [
      { header: "*RemittanceID", key: "RemittanceID", width: 30 },
      { header: "*UTR", key: "UTR", width: 40 },
      // { header: "*CODAmount", key: "CODAmount", width: 40 },
    ];

    // Add a sample row with mandatory product 1 and optional products
    worksheet.addRow({
      RemittanceID: "57432",
      UTR: "PAY67890",
      // CODAmount: "1000",
    });

    // Format the header row
    worksheet.getRow(1).eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.font = { bold: true }; // Make headers bold
    });

    // Set response headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=sample.xlsx");

    // Write workbook to response stream
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating Excel file:", error);
    res
      .status(500)
      .json({ error: "Error generating Excel file", details: error.message });
  }
};

function parseCSV(filePath, fileData) {
  return new Promise((resolve, reject) => {
    const orders = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on("data", async (row) => {
        // orders.push(row);
        try {
          const order = new bulkOrdersCSV({
            fileId: fileData._id,
            orderId: row["*Order Id"],
            orderDate: row["Order Date as dd-mm-yyyy hh:MM"] || null,
            channel: row["*Channel"],
            paymentMethod: row["*Payment Method(COD/Prepaid)"],
            customer: {
              firstName: row["*Customer First Name"],
              lastName: row["Customer Last Name"] || "",
              email: row["Email (Optional)"] || "",
              mobile: row["*Customer Mobile"],
              alternateMobile: row["Customer Alternate Mobile"] || "",
            },
            shippingAddress: {
              line1: row["*Shipping Address Line 1"],
              line2: row["Shipping Address Line 2"] || "",
              country: row["*Shipping Address Country"],
              state: row["*Shipping Address State"],
              city: row["*Shipping Address City"],
              postcode: row["*Shipping Address Postcode"],
            },
            billingAddress: {
              line1: row["Billing Address Line 1"] || "",
              line2: row["Billing Address Line 2"] || "",
              country: row["Billing Address Country"] || "",
              state: row["Billing Address State"] || "",
              city: row["Billing Address City"] || "",
              postcode: row["Billing Address Postcode"] || "",
            },
            orderDetails: {
              masterSKU: row["*Master SKU"],
              name: row["*Product Name"],
              quantity: parseInt(row["*Product Quantity"]) || 0,
              taxPercentage: parseFloat(row["Tax %"]),
              sellingPrice: parseFloat(
                row["*Selling Price(Per Unit Item, Inclusive of Tax)"]
              ),
              discount: parseFloat(row["Discount(Per Unit Item)"]) || 0,
              shippingCharges: parseFloat(
                row["Shipping Charges(Per Order)"] || 0
              ),
              codCharges: parseFloat(row["COD Charges(Per Order)"] || 0),
              giftWrapCharges: parseFloat(
                row["Gift Wrap Charges(Per Order)"] || 0
              ),
              totalDiscount: parseFloat(row["Total Discount (Per Order)"] || 0),
              dimensions: {
                length: parseFloat(row["*Length (cm)"]),
                breadth: parseFloat(row["*Breadth (cm)"]),
                height: parseFloat(row["*Height (cm)"]),
              },
              weight: parseFloat(row["*Weight Of Shipment(kg)"]),
            },
            sendNotification:
              row["Send Notification(True/False)"].toLowerCase() === "true",
            comment: row["Comment"] || "",
            hsnCode: row["HSN Code"] || "",
            locationId: row["Location Id"] || "",
            resellerName: row["Reseller Name"] || "",
            companyName: row["Company Name"] || "",
            latitude: parseFloat(row["latitude"] || 0),
            longitude: parseFloat(row["longitude"] || 0),
            verifiedOrder: row["Verified Order"] === "1",
            isDocuments: row["Is documents"] || "No",
            orderType: row["Order Type"] || "",
            orderTag: row["Order tag"] || "",
          });
          await order.save();
          console.log(`Imported order: ${order.orderId}`);
        } catch (error) {
          console.error(`Error importing order: ${row["*Order Id"]}`, error);
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed");
        resolve(orders);
      })
      .on("error", (error) => {
        console.log("CSV Parsing error:", error);
        reject(error);
      });
  });
}

// Helper function to read Excel file (.xlsx, .xls)
function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(sheet);
  return data;
}

const uploadCodRemittance = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Save file metadata
    const fileData = new File({
      filename: req.file.filename,
      date: new Date(),
      status: "Processing",
    });
    await fileData.save();

    // Determine file extension
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let codRemittances = [];

    if (fileExtension === ".csv") {
      codRemittances = await parseCSV(req.file.path, fileData);
    } else if (fileExtension === ".xlsx" || fileExtension === ".xls") {
      codRemittances = await parseExcel(req.file.path);
    } else {
      return res.status(400).json({ error: "Unsupported file format" });
    }

    if (!codRemittances || codRemittances.length === 0) {
      return res
        .status(400)
        .json({ error: "The uploaded file is empty or contains invalid data" });
    }

    for (const row of codRemittances) {
      const remittance = await adminCodRemittance.findOne({
        remitanceId: row["*RemittanceID"],
      });

      if (!remittance) {
        return res
          .status(400)
          .json({ error: `Remittance ID ${row["*RemittanceID"]} not found.` });
      }

      if (remittance.status === "Paid") {
        console.log(
          `Remittance ID ${row["*RemittanceID"]} is already paid. Skipping reprocessing.`
        );
        continue;
      }

      let userRemittance = await codRemittance.findOne({
        userId: remittance.userId,
      });

      if (!userRemittance) {
        userRemittance = new codRemittance({
          userId: remittance.userId,
          TotalCODRemitted: 0,
          RemittanceInitiated: 0,
          remittanceData: [],
        });
        await userRemittance.save();
      }

      // Ensure numeric fields
      userRemittance.TotalCODRemitted ??= 0;
      userRemittance.RemittanceInitiated ??= 0;
      userRemittance.remittanceData ??= [];

      const currentRemittanceEntry = userRemittance.remittanceData.find(
        (entry) => entry.remittanceId === remittance.remitanceId
      );

      if (currentRemittanceEntry) {
        const actualAmount = Number(currentRemittanceEntry.codAvailable || 0);

        if (actualAmount > 0) {
          if (userRemittance.RemittanceInitiated >= actualAmount) {
            userRemittance.RemittanceInitiated -= actualAmount;
            userRemittance.LastCODRemitted = actualAmount;
          } else {
            console.warn(
              `RemittanceInitiated (${userRemittance.RemittanceInitiated}) less than actualAmount (${actualAmount}), setting to 0 to avoid negative value.`
            );
            userRemittance.LastCODRemitted = userRemittance.RemittanceInitiated;
            userRemittance.RemittanceInitiated = 0;
          }
        } else {
          console.warn(
            `Actual amount is zero or negative (${actualAmount}), no deduction.`
          );
        }

        // Mark all orders as Paid
        if (remittance.orderDetails && Array.isArray(remittance.orderDetails.orders)) {
          for (const item of remittance.orderDetails.orders) {
            const order = await Order.findOne({ _id: item });
            if (!order) {
              console.log(`Order with ID ${item} not found.`);
              continue;
            }
            await CodRemittanceOrdersModel.findOneAndUpdate(
              { orderID: order.orderId },
              { $set: { status: "Paid" } }
            );
          }
        }
      } else {
        console.warn(
          `No remittanceData entry found for remittanceId ${remittance.remitanceId}`
        );
      }

      // ✅ Only update TotalCODRemitted (always safe — this tracks total ever paid)
      userRemittance.TotalCODRemitted += Number(remittance.totalCod || 0);

      // ✅ Safety check
      if (isNaN(userRemittance.TotalCODRemitted)) {
        console.error("Invalid TotalCODRemitted detected:", {
          TotalCODRemitted: userRemittance.TotalCODRemitted,
        });
        return res
          .status(500)
          .json({ error: "Invalid TotalCODRemitted value" });
      }

      // Update or add entry
      const existingRemittanceEntryIndex =
        userRemittance.remittanceData.findIndex(
          (entry) => entry.remittanceId === remittance.remitanceId
        );

      if (existingRemittanceEntryIndex !== -1) {
        userRemittance.remittanceData[existingRemittanceEntryIndex].utr =
          row["*UTR"] || "N/A";
        userRemittance.remittanceData[
          existingRemittanceEntryIndex
        ].remittanceMethod = "Bank Transaction";
        userRemittance.remittanceData[existingRemittanceEntryIndex].status =
          "Paid";
      } else {
        userRemittance.remittanceData.push({
          date: remittance.date,
          remittanceId: remittance.remitanceId,
          utr: row["*UTR"] || "N/A",
          codAvailable: remittance.totalCod || 0,
          amountCreditedToWallet: remittance.amountCreditedToWallet || 0,
          earlyCodCharges: remittance.earlyCodCharges || 0,
          adjustedAmount: remittance.adjustedAmount || 0,
          remittanceMethod: "Bank Transaction",
          status: "Paid",
          orderDetails: {
            date: remittance.orderDetails.date,
            codcal: remittance.orderDetails.codcal,
            orders: [...remittance.orderDetails.orders],
          },
        });
      }

      await userRemittance.save();

      remittance.status = "Paid";
      await remittance.save();
    }

    // Delete uploaded file
    fs.unlink(req.file.path, (err) => {
      if (err) console.error("Error deleting file:", err);
    });

    return res.status(200).json({
      message: "COD Remittance uploaded successfully",
      file: fileData,
    });
  } catch (error) {
    console.error("Error in uploadCodRemittance:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing the file" });
  }
};

const CheckCodplan = async (req, res) => {
  try {
    // console.log("reddd", req.query);
    const { id } = req.query;
    const userId = id || req.user?._id; // Ensure req.user exists
    if (!userId) {
      return res.status(400).json({ error: "User ID not found" });
    }

    const codplans = await CodPlan.findOne({ user: userId });
    if (!codplans) {
      return res.status(200).json({
        message: "No plan found",
        codplaneName: "D+7",
        planCharges: 0,
        isCustom: false,
        remittanceDay: null,
      });
    }
    res.status(200).json({
      message: "User ID retrieved successfully",
      codplaneName: codplans.planName,
      planCharges: codplans.planCharges,
      isCustom: codplans.isCustom,
      remittanceDay: codplans.remittanceDay,
    });
  } catch (error) {
    console.error("Error in checkCodPlan:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const remittanceTransactionData = async (req, res) => {
  try {
    const { id } = req.params; // Remittance ID
    const userID = req.user._id;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Remittance ID is required.",
      });
    }

    // Fetch remittance data for the current user
    const remittanceData = await codRemittance
      .findOne({ userId: userID })
      .lean();
    if (!remittanceData) {
      return res.status(404).json({
        success: false,
        message: "Remittance data not found.",
      });
    }

    // Find the specific remittance transaction
    const result = remittanceData.remittanceData.find(
      (item) => String(item.remittanceId) === String(id)
    );
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found.",
      });
    }

    if (!result.orderDetails || !Array.isArray(result.orderDetails.orders)) {
      return res.status(400).json({
        success: false,
        message: "Invalid remittance order details.",
      });
    }

    // Fetch all orders in a single query for performance
    const orderdata = await Order.find({
      _id: { $in: result.orderDetails.orders },
    }).lean();

    // Parallel fetch: Bank details + Wallet info
    const [bankDetails, user] = await Promise.all([
      BankAccountDetails.findOne({ user: userID }).lean(),
      users.findById(userID).lean(),
    ]);

    const wallet = user?.Wallet
      ? await Wallet.findById(user.Wallet).lean().select("balance")
      : null;

    // Construct the response object (aligned with seller controller)
    const transactions = {
      remittanceId: id,
      date: result.date || "N/A",
      totalOrder: orderdata.length,
      totalCOD: result.orderDetails?.codcal || 0,
      remittanceAmount: result.codAvailable || 0,
      reason: result.reason || "N/A",
      // deliveryDate: orderdata.tracking[orderdata.tracking.lentgh-1].StatusDateTime || "N/A",
      status: result.status || "N/A",
      orderDataInArray: orderdata,
      bankDetails: {
        accountHolderName: bankDetails?.nameAtBank || "N/A",
        accountNumber: bankDetails?.accountNumber || "N/A",
        ifscCode: bankDetails?.ifsc || "N/A",
        bankName: bankDetails?.bank || "N/A",
        branchName: bankDetails?.branch || "N/A",
        balance: wallet?.balance || 0,
      },
    };

    return res.status(200).json({
      success: true,
      message: "Remittance transaction data retrieved successfully.",
      data: transactions,
    });
  } catch (error) {
    console.error("Error fetching remittance transactions:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving transaction data.",
      error: error.message,
    });
  }
};

const courierCodRemittance = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit = limitQuery === "All" ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const searchFilter = req.query.searchFilter?.trim().toLowerCase() || "";
    const orderID = req.query.orderID?.trim() || "";
    const awbNumber = req.query.awbNumber?.trim() || "";
    const statusFilter = req.query.statusFilter?.trim() || "";
    const courierProvider = req.query.courierProvider?.trim() || "";

    let matchStage = {};

    // Employee AWB restriction
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      const allocatedUserIds = allocations.map((a) =>
        a.sellerMongoId.toString()
      );

      if (allocatedUserIds.length === 0) {
        return res.status(200).json({
          success: true,
          message: "COD remittance orders retrieved successfully",
          total: 0,
          page,
          limit: limit || "All",
          totalPages: 1,
          data: {
            totalCODAmount: 0,
            paidCODAmount: 0,
            pendingCODAmount: 0,
            orders: [],
          },
        });
      }

      const orders = await Order.find(
        {
          userId: {
            $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
        { awb_number: 1 }
      ).lean();

      const allowedAwbNumbers = orders
        .map((o) => o.awb_number?.toString())
        .filter(Boolean);
      if (allowedAwbNumbers.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No COD remittance orders for this employee",
          total: 0,
          page,
          limit: limit || "All",
          totalPages: 1,
          data: {
            totalCODAmount: 0,
            paidCODAmount: 0,
            pendingCODAmount: 0,
            orders: [],
          },
        });
      }

      matchStage.AwbNumber = { $in: allowedAwbNumbers };
    }

    // Search filter
    if (searchFilter) {
      matchStage.$or = [
        { userName: { $regex: searchFilter, $options: "i" } },
        { PhoneNumber: { $regex: searchFilter, $options: "i" } },
        { Email: { $regex: searchFilter, $options: "i" } },
      ];
    }

    // Order ID filter
    if (orderID) {
      const ids = orderID.split(",").map(v => v.trim());
      matchStage.orderID = { $in: ids };
    }

    // AWB filter
    if (awbNumber) {
      const awbs = awbNumber.split(",").map(v => v.trim());
      matchStage.AwbNumber = { $in: awbs };
    }

    // Status filter
    if (statusFilter) {
      matchStage.status = { $regex: new RegExp(`^${statusFilter}$`, "i") };
    }

    // Courier provider filter (Multi-select)
    if (courierProvider) {
      const couriers = courierProvider.split(",").map(c => c.trim());
      matchStage.courierServiceName = { $in: couriers.map(c => new RegExp(`^${c}$`, "i")) };
    }


    // Fetch and paginate in MongoDB
    const aggregationPipeline = [
      { $match: matchStage },
      {
        $addFields: {
          codAmountNum: { $toDouble: { $ifNull: ["$CODAmount", 0] } },
        },
      },
      { $sort: { _id: -1 } },
    ];

    if (limit) {
      aggregationPipeline.push({ $skip: skip }, { $limit: limit });
    }

    aggregationPipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      {
        $addFields: {
          userId: { $ifNull: [{ $arrayElemAt: ["$userInfo.userId", 0] }, "$userId"] },
        },
      }
    );

    const orders = await CourierCodRemittance.aggregate(aggregationPipeline);

    // Calculate totals directly in DB
    const totalsAgg = await CourierCodRemittance.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalCODAmount: {
            $sum: { $toDouble: { $ifNull: ["$CODAmount", 0] } },
          },
          paidCODAmount: {
            $sum: {
              $cond: [
                { $eq: ["$status", "Paid"] },
                { $toDouble: { $ifNull: ["$CODAmount", 0] } },
                0,
              ],
            },
          },
          pendingCODAmount: {
            $sum: {
              $cond: [
                { $eq: ["$status", "Pending"] },
                { $toDouble: { $ifNull: ["$CODAmount", 0] } },
                0,
              ],
            },
          },
        },
      },
    ]);

    const totals = totalsAgg[0] || {
      totalCODAmount: 0,
      paidCODAmount: 0,
      pendingCODAmount: 0,
    };

    const totalCount = await CourierCodRemittance.countDocuments(matchStage);
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    return res.status(200).json({
      success: true,
      message: "COD remittance orders retrieved successfully",
      total: totalCount,
      page,
      limit: limit || "All",
      totalPages,
      data: { ...totals, orders },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving COD remittance orders",
      error: error.message,
    });
  }
};

const getAdminCodRemitanceData = async (req, res) => {
  try {
    const {
      userNameFilter,
      selectedUserId,
      startDate,
      endDate,
      statusFilter,
      page = 1,
      limit = 20,
      remittanceIdFilter,
      utr,
    } = req.query;

    // console.log("query", req.query);

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * (parsedLimit || 0);

    // ---------- Base filters ----------
    const userIdFilter = {};
    const remittanceMatchStage = {};

    // Employee allocation filter (optional: applies if there is employee context)
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      const allocatedUserIds = allocations.map(
        (a) => new mongoose.Types.ObjectId(a.sellerMongoId)
      );
      if (allocatedUserIds.length === 0) {
        return res.json({
          total: 0,
          page: Number(page),
          limit: parsedLimit === 0 ? "all" : parsedLimit,
          results: [],
          summary: {
            CODToBeRemitted: 0,
            RemittanceInitiated: 0,
            TotalDeductionfromCOD: 0,
            TotalCODRemitted: 0,
            LastCodRemmited: null,
          },
        });
      }
      userIdFilter.userId = { $in: allocatedUserIds };
    }

    // Add filtering by selectedUserId if provided
    if (selectedUserId) {
      try {
        userIdFilter.userId = new mongoose.Types.ObjectId(selectedUserId);
      } catch {
        return res.status(400).json({ message: "Invalid selectedUserId" });
      }
    }

    // Date filter
    if (startDate && endDate) {
      const sDate = new Date(startDate);
      sDate.setHours(0, 0, 0, 0);
      const eDate = new Date(endDate);
      eDate.setHours(23, 59, 59, 999);
      remittanceMatchStage["remittanceData.date"] = {
        $gte: sDate,
        $lte: eDate,
      };
    }

    // Status / remittanceId / utr filters on remittanceData
    if (statusFilter)
      remittanceMatchStage["remittanceData.status"] = statusFilter;
    if (remittanceIdFilter)
      remittanceMatchStage["remittanceData.remittanceId"] = remittanceIdFilter;
    if (utr) remittanceMatchStage["remittanceData.utr"] = utr;

    // Base pipeline for user lookup and filtering user data
    const basePipeline = [
      { $match: userIdFilter },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      ...(userNameFilter
        ? [
          {
            $match: {
              $or: [
                ...(mongoose.Types.ObjectId.isValid(userNameFilter)
                  ? [
                    {
                      "user._id": new mongoose.Types.ObjectId(
                        userNameFilter
                      ),
                    },
                  ]
                  : []),
                { "user.email": new RegExp(userNameFilter, "i") },
                { "user.fullname": new RegExp(userNameFilter, "i") },
              ],
            },
          },
        ]
        : []),
    ];

    // Work on remittanceData - unwind first, then apply remittance filters
    const remittanceFilteringPipeline = [
      { $unwind: "$remittanceData" },
      { $match: remittanceMatchStage },
    ];

    // Group by remittanceId to get unique remittance entries
    const groupByRemittanceId = {
      $group: {
        _id: "$remittanceData.remittanceId",
        doc: { $first: "$$ROOT" },
      },
    };

    const replaceRoot = { $replaceRoot: { newRoot: "$doc" } };

    // Add fields: numeric conversions and sum for codAvailable and related amounts
    const addFieldsForNumbers = {
      $addFields: {
        codAvailableNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.codAvailable" },
                      { $gt: [{ $size: "$remittanceData.codAvailable" }, 0] },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                  "$remittanceData.codAvailable",
                ],
              },
              0,
            ],
          },
        },
        amountCreditedToWalletNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.amountCreditedToWallet" },
                      {
                        $gt: [
                          { $size: "$remittanceData.amountCreditedToWallet" },
                          0,
                        ],
                      },
                    ],
                  },
                  {
                    $arrayElemAt: ["$remittanceData.amountCreditedToWallet", 0],
                  },
                  "$remittanceData.amountCreditedToWallet",
                ],
              },
              0,
            ],
          },
        },
        earlyCodChargesNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.earlyCodCharges" },
                      {
                        $gt: [{ $size: "$remittanceData.earlyCodCharges" }, 0],
                      },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.earlyCodCharges", 0] },
                  "$remittanceData.earlyCodCharges",
                ],
              },
              0,
            ],
          },
        },
        adjustedAmountNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.adjustedAmount" },
                      { $gt: [{ $size: "$remittanceData.adjustedAmount" }, 0] },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.adjustedAmount", 0] },
                  "$remittanceData.adjustedAmount",
                ],
              },
              0,
            ],
          },
        },
        remittanceInitiatedNum: {
          $toDouble: {
            $ifNull: [
              {
                $cond: [
                  {
                    $and: [
                      { $isArray: "$remittanceData.codAvailable" },
                      { $gt: [{ $size: "$remittanceData.codAvailable" }, 0] },
                    ],
                  },
                  { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                  "$remittanceData.codAvailable",
                ],
              },
              0,
            ],
          },
        },
        codAvailableSum: {
          $add: [
            {
              $toDouble: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          { $isArray: "$remittanceData.codAvailable" },
                          {
                            $gt: [{ $size: "$remittanceData.codAvailable" }, 0],
                          },
                        ],
                      },
                      { $arrayElemAt: ["$remittanceData.codAvailable", 0] },
                      "$remittanceData.codAvailable",
                    ],
                  },
                  0,
                ],
              },
            },
            {
              $toDouble: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          {
                            $isArray: "$remittanceData.amountCreditedToWallet",
                          },
                          {
                            $gt: [
                              {
                                $size: "$remittanceData.amountCreditedToWallet",
                              },
                              0,
                            ],
                          },
                        ],
                      },
                      {
                        $arrayElemAt: [
                          "$remittanceData.amountCreditedToWallet",
                          0,
                        ],
                      },
                      "$remittanceData.amountCreditedToWallet",
                    ],
                  },
                  0,
                ],
              },
            },
            {
              $toDouble: {
                $ifNull: [
                  {
                    $cond: [
                      {
                        $and: [
                          { $isArray: "$remittanceData.earlyCodCharges" },
                          {
                            $gt: [
                              { $size: "$remittanceData.earlyCodCharges" },
                              0,
                            ],
                          },
                        ],
                      },
                      { $arrayElemAt: ["$remittanceData.earlyCodCharges", 0] },
                      "$remittanceData.earlyCodCharges",
                    ],
                  },
                  0,
                ],
              },
            },
          ],
        },
      },
    };

    // Final projection
    const projectFields = {
      $project: {
        _id: 0,
        user: {
          userId: "$user.userId",
          name: "$user.fullname",
          email: "$user.email",
          phoneNumber: "$user.phoneNumber",
        },
        remittanceId: "$remittanceData.remittanceId",
        date: "$remittanceData.date",
        status: "$remittanceData.status",
        remittanceMethod: "$remittanceData.remittanceMethod",
        utr: "$remittanceData.utr",
        codAvailable: "$codAvailableSum", // sum of codAvailable + amountCreditedToWallet + earlyCodCharges
        remittanceInitiated: "$remittanceInitiatedNum", // original codAvailable
        amountCreditedToWallet: "$amountCreditedToWalletNum",
        earlyCodCharges: "$earlyCodChargesNum",
        adjustedAmount: "$adjustedAmountNum",
      },
    };

    const sortingAndPagination = [
      { $sort: { date: -1 } },
      ...(parsedLimit === 0 ? [] : [{ $skip: skip }, { $limit: parsedLimit }]),
    ];

    // Full pipeline for fetching results
    const rowsPipeline = [
      ...basePipeline,
      ...remittanceFilteringPipeline,
      groupByRemittanceId,
      replaceRoot,
      addFieldsForNumbers,
      projectFields,
      ...sortingAndPagination,
    ];

    const rows = await codRemittance.aggregate(rowsPipeline);

    // Count pipeline for total count
    const countPipeline = [
      ...basePipeline,
      { $unwind: "$remittanceData" },
      { $match: remittanceMatchStage },
      { $count: "total" },
    ];

    const countResult = await codRemittance.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

    // Summary aggregation: apply filters on remittanceData to get accurate summary for filtered data
    const aggregationSummary = await codRemittance.aggregate([
      { $match: userIdFilter },
      {
        $group: {
          _id: null,
          CODToBeRemitted: { $sum: "$CODToBeRemitted" },
          RemittanceInitiated: { $sum: "$RemittanceInitiated" },
          TotalDeductionfromCOD: { $sum: "$TotalDeductionfromCOD" },
          TotalCODRemitted: { $sum: "$TotalCODRemitted" },
          LastCODRemitted: { $sum: "$LastCODRemitted" }, // replace with your actual last remittance date field if any, else remove
        },
      },
      {
        $project: {
          _id: 0,
          CODToBeRemitted: 1,
          RemittanceInitiated: 1,
          TotalDeductionfromCOD: 1,
          TotalCODRemitted: 1,
          LastCODRemitted: 1,
        },
      },
    ]);

    const summary = aggregationSummary[0] || {
      CODToBeRemitted: 0,
      RemittanceInitiated: 0,
      TotalDeductionfromCOD: 0,
      TotalCODRemitted: 0,
      LastCodRemmited: 0,
    };
    const totalPages = parsedLimit === 0 ? 1 : Math.ceil(total / parsedLimit);
    res.json({
      total,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results: rows,
      summary,
      totalPages,
    });
  } catch (error) {
    console.error("Error in getAllCodRemittance:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const CodRemittanceOrder = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit = limitQuery === "All" ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const {
      searchFilter = "",
      orderID = "",
      awbNumber = "",
      statusFilter = "",
      courierProvider = "",
      startDate,
      endDate,
      userId,
      selectedUserId,
      userSearch,
    } = req.query;

    const targetUserId = userId || selectedUserId || userSearch;

    const andConditions = [];

    // Employee role filtering
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      const allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (!allocatedUserIds.length) {
        return res.status(200).json({
          success: true,
          message: "No allocated users",
          total: 0,
          page,
          limit: limit || "All",
          totalPages: 1,
          data: {
            totalCODAmount: 0,
            paidCODAmount: 0,
            pendingCODAmount: 0,
            orders: [],
          },
        });
      }
      andConditions.push({
        userId: { $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)) }
      });
    }

    if (statusFilter) {
      andConditions.push({ status: statusFilter });
    }

    if (targetUserId) {
      try {
        const userDoc = await User.findById(targetUserId);
        if (userDoc) {
          andConditions.push({
            $or: [
              { userId: new mongoose.Types.ObjectId(targetUserId) },
              { Email: { $regex: new RegExp(`^${userDoc.email}$`, "i") } }
            ]
          });
        } else if (mongoose.Types.ObjectId.isValid(targetUserId)) {
          andConditions.push({ userId: new mongoose.Types.ObjectId(targetUserId) });
        }
      } catch (err) {
        if (mongoose.Types.ObjectId.isValid(targetUserId)) {
          andConditions.push({ userId: new mongoose.Types.ObjectId(targetUserId) });
        }
      }
    }

    if (startDate && endDate) {
      andConditions.push({
        Date: {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        }
      });
    }

    if (orderID) {
      const filterValues = orderID.split(",").map((val) => val.trim());
      andConditions.push({ orderID: { $in: filterValues } });
    }

    if (awbNumber) {
      const filterValues = awbNumber.split(",").map((val) => val.trim());
      andConditions.push({ AWB_Number: { $in: filterValues } });
    }

    if (courierProvider) {
      const couriers = courierProvider.split(",").map(c => c.trim());
      andConditions.push({ courierProvider: { $in: couriers.map(c => new RegExp(`^${c}$`, "i")) } });
    }

    if (searchFilter) {
      const searchRegex = new RegExp(searchFilter.trim(), "i");
      andConditions.push({
        $or: [
          { userName: { $regex: searchRegex } },
          { PhoneNumber: { $regex: searchRegex } },
          { Email: { $regex: searchRegex } }
        ]
      });
    }

    let matchStage = {};
    if (andConditions.length > 0) {
      matchStage = { $and: andConditions };
    }

    // Calculate totals directly in MongoDB (runs extremely fast with indexes)
    const totalsAgg = await CodRemittanceOrdersModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalCODAmount: {
            $sum: { $toDouble: { $ifNull: ["$CODAmount", 0] } },
          },
          paidCODAmount: {
            $sum: {
              $cond: [
                { $eq: ["$status", "Paid"] },
                { $toDouble: { $ifNull: ["$CODAmount", 0] } },
                0,
              ],
            },
          },
          pendingCODAmount: {
            $sum: {
              $cond: [
                { $eq: ["$status", "Pending"] },
                { $toDouble: { $ifNull: ["$CODAmount", 0] } },
                0,
              ],
            },
          },
        },
      },
    ]);

    const totals = totalsAgg[0] || {
      totalCODAmount: 0,
      paidCODAmount: 0,
      pendingCODAmount: 0,
    };

    // Count total matching records directly in DB
    const totalCount = await CodRemittanceOrdersModel.countDocuments(matchStage);
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    // Build the aggregation pipeline for paginated records.
    // Notice that pagination happens BEFORE the $lookup join.
    // This resolves the N+1 join performance problem completely.
    const aggregationPipeline = [
      { $match: matchStage },
      { $sort: { _id: -1 } },
    ];

    if (limit) {
      aggregationPipeline.push({ $skip: skip }, { $limit: limit });
    }

    aggregationPipeline.push(
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      {
        $addFields: {
          codAmountNum: { $toDouble: { $ifNull: ["$CODAmount", 0] } },
          userId: { $ifNull: [{ $arrayElemAt: ["$userInfo.userId", 0] }, "$userId"] },
        },
      }
    );

    const orders = await CodRemittanceOrdersModel.aggregate(aggregationPipeline);

    return res.status(200).json({
      success: true,
      message: "COD remittance orders retrieved successfully",
      total: totalCount,
      page,
      limit: limit || "All",
      totalPages,
      data: {
        totalCODAmount: totals.totalCODAmount,
        paidCODAmount: totals.paidCODAmount,
        pendingCODAmount: totals.pendingCODAmount,
        orders,
      },
    });
  } catch (error) {
    console.error("Error fetching COD remittance orders:", error.message);
    return res.status(500).json({
      success: false,
      message: "An error occurred while retrieving COD remittance orders",
      error: error.message,
    });
  }
};

const sellerremittanceTransactionData = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Remittance ID is required.",
      });
    }

    // Fetch ONLY the required remittance entry (FAST)
    const remittanceData = await adminCodRemittance
      .findOne(
        { remitanceId: id },
        {
          remitanceId: 1,
          userId: 1,
          date: 1,
          status: 1,
          reason: 1,
          codAvailable: 1,
          orderDetails: 1,
        }
      )
      .lean();

    if (!remittanceData) {
      return res.status(404).json({
        success: false,
        message: "Remittance data not found.",
      });
    }

    const userId = remittanceData.userId;

    // Fetch Bank + User (Wallet ID) in PARALLEL
    const [bankDetails, user] = await Promise.all([
      BankAccountDetails.findOne({ user: userId })
        .lean()
        .select("nameAtBank accountNumber ifsc bank branch"),
      users.findById(userId).lean().select("Wallet"),
    ]);

    // Fetch Wallet balance only if wallet exists
    const walletPromise = user?.Wallet
      ? Wallet.findById(user.Wallet).lean().select("balance")
      : Promise.resolve(null);

    const wallet = await walletPromise;

    // Fetch orders with projection (FAST)
    const orderIds = remittanceData.orderDetails?.orders || [];

    const filteredOrders = orderIds.length
      ? await Order.find(
        { _id: { $in: orderIds } },
        {
          orderId: 1,
          awb_number: 1,
          provider: 1,
          courierServiceName: 1,
          tracking: 1,
          paymentDetails: 1,
        }
      ).lean()
      : [];

    const transactions = {
      remitanceId: id,
      date: remittanceData.date || "N/A",
      totalOrder: filteredOrders.length,
      totalCOD: remittanceData.orderDetails?.codcal || 0,
      remitanceAmount: remittanceData.codAvailable || 0,
      deliveryDate: remittanceData.orderDetails?.date || "N/A",
      reason: remittanceData.reason || "N/A",
      status: remittanceData.status || "N/A",

      orderDataInArray: filteredOrders,

      bankDetails: {
        accountHolderName: bankDetails?.nameAtBank || "N/A",
        accountNumber: bankDetails?.accountNumber || "N/A",
        ifscCode: bankDetails?.ifsc || "N/A",
        bankName: bankDetails?.bank || "N/A",
        branchName: bankDetails?.branch || "N/A",
        balance: wallet?.balance || 0,
      },
    };

    return res.status(200).json({
      success: true,
      message: "Remittance transaction data retrieved successfully.",
      data: transactions,
    });
  } catch (error) {
    console.error("Error fetching remittance transaction data:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while retrieving transaction data.",
      error: error.message,
    });
  }
};

const CourierdownloadSampleExcel = async (req, res) => {
  try {
    // Create a new workbook and add a worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sample Bulk Order");

    // Define headers
    worksheet.columns = [
      { header: "*AWB Number", key: "AWBNumber", width: 30 },
      { header: "*COD Amount", key: "CODAmount", width: 40 },
      // { header: "*CODAmount", key: "CODAmount", width: 40 },
    ];

    // Add a sample row with mandatory product 1 and optional products
    worksheet.addRow({
      AWBNumber: "5743267565",
      CODAmount: "500",
      // CODAmount: "1000",
    });

    // Format the header row
    worksheet.getRow(1).eachCell((cell) => {
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.font = { bold: true }; // Make headers bold
    });

    // Set response headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=sample.xlsx");

    // Write workbook to response stream
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error generating Excel file:", error);
    res
      .status(500)
      .json({ error: "Error generating Excel file", details: error.message });
  }
};
const uploadCourierCodRemittance = async (req, res) => {
  try {
    const userID = req.user._id;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Save file metadata
    const fileData = new File({
      filename: req.file.filename,
      date: new Date(),
      status: "Processing",
    });
    await fileData.save();

    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    let codRemittances = [];

    // Parse file
    if (fileExtension === ".csv") {
      codRemittances = await parseCSV(req.file.path, fileData);
    } else if ([".xlsx", ".xls"].includes(fileExtension)) {
      codRemittances = await parseExcel(req.file.path);
    } else {
      return res.status(400).json({ error: "Unsupported file format" });
    }

    if (!codRemittances?.length) {
      return res.status(400).json({
        error: "The uploaded file is empty or contains invalid data",
      });
    }

    // Normalize keys for matching and extract all unique AWB numbers
    const normalize = (val) => (val ? val.toString().trim() : "");
    const awbList = codRemittances
      .map((row) => normalize(row["*AWB Number"] || row["AWBNumber"] || row["AWB Number"] || row["*AWBNumber"]))
      .filter(Boolean);

    let updatedCount = 0;

    if (awbList.length > 0) {
      // Execute a single high-performance bulk update query (index-backed, executed in <100ms)
      const updateResult = await CourierCodRemittance.updateMany(
        {
          AwbNumber: { $in: awbList },
          status: "Pending"
        },
        {
          $set: { status: "Paid" }
        }
      );
      updatedCount = updateResult.modifiedCount;
    }

    // Update bulk file upload status
    fileData.status = "Completed";
    await fileData.save();

    // Delete file after DB update
    fs.unlink(req.file.path, (err) => {
      if (err) console.error("Error deleting file:", err);
      else console.log("File deleted successfully:", req.file.path);
    });

    if (updatedCount === 0) {
      return res.status(400).json({
        error: "No pending courier COD remittance records were found or updated for the uploaded AWBs.",
      });
    }

    return res.status(200).json({
      message: `${updatedCount} Courier COD remittance record(s) uploaded and marked as Paid successfully`,
      file: fileData,
    });
  } catch (error) {
    console.error("Error in uploadCourierCodRemittance:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing the file" });
  }
};

const exportOrderInRemittance = async (req, res) => {
  try {
    const userID = req.user._id;
    const rawIds = req.query.ids;
    const ids = rawIds ? [].concat(rawIds) : [];

    if (!ids.length) {
      return res
        .status(400)
        .json({ message: "Remittance IDs are required." });
    }
    // Fetch remittance records (orderDetails is an embedded object, not a ref)
    const remittances = await adminCodRemittance.find({ remitanceId: { $in: ids } });

    // Collect all order ObjectIds and build a reverse map to remittanceId
    const orderIdToRemittanceId = {};
    for (const remittance of remittances) {
      const remittanceOrderIds = remittance.orderDetails?.orders || [];
      for (const oid of remittanceOrderIds) {
        orderIdToRemittanceId[oid.toString()] = remittance.remitanceId;
      }
    }
    const allOrderIds = Object.keys(orderIdToRemittanceId);

    const rawOrders = await Order.find(
      { _id: { $in: allOrderIds } },
      {
        orderId: 1,
        courierServiceName: 1,
        awb_number: 1,
        "paymentDetails.method": 1,
        "paymentDetails.amount": 1,
        tracking: 1,
      }
    );

    // Index fetched orders by _id for O(1) lookup
    const orderMap = {};
    for (const order of rawOrders) {
      orderMap[order._id.toString()] = order;
    }

    // Build result grouped by remittanceId, in the same order as the requested ids
    const orderDetails = [];
    for (const remitId of ids) {
      const remittance = remittances.find((r) => String(r.remitanceId) === String(remitId));
      if (!remittance) continue;
      const remittanceOrderIds = remittance.orderDetails?.orders || [];
      for (const oid of remittanceOrderIds) {
        const order = orderMap[oid.toString()];
        if (!order) continue;
        const deliveryEvent = order.tracking.find(
          (event) => event.status?.toLowerCase() === "delivered"
        );
        orderDetails.push({
          remittanceId: remittance.remitanceId,
          remittanceDate: remittance.date
            ? new Date(remittance.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
            : null,
          orderId: order.orderId,
          courierServiceName: order.courierServiceName,
          awb_number: order.awb_number,
          paymentMethod: order.paymentDetails?.method,
          paymentAmount: order.paymentDetails?.amount,
          deliveryDate: deliveryEvent?.StatusDateTime
            ? new Date(deliveryEvent.StatusDateTime).toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })
            : null,
        });
      }
    }

    res.json({
      success: true,
      totalOrders: orderDetails.length,
      orders: orderDetails,
    });
  } catch (error) {
    console.error("Error exporting remittance orders:", error);
    res
      .status(500)
      .json({ message: "Server error while exporting remittance orders" });
  }
};

const validateCODTransfer = async (req, res) => {
  try {
    const remittanceIds = req.body.remittanceIds;

    if (!Array.isArray(remittanceIds) || remittanceIds.length === 0) {
      return res.status(400).json({ message: "Remittance IDs are required." });
    }

    // Step 1: Fetch all selected remittances
    const remittances = await adminCodRemittance
      .find({ remitanceId: { $in: remittanceIds } })
      .lean();

    // Step 2: Validate all selected IDs exist
    if (remittances.length !== remittanceIds.length) {
      return res.status(400).json({
        message: "Some remittance IDs are invalid.",
      });
    }

    // ❗ Step 3: Check if any selected remittance is already paid
    const alreadyPaid = remittances.filter((r) => r.status === "Paid");

    if (alreadyPaid.length > 0) {
      return res.status(400).json({
        message: "One or more selected remittances are already paid.",
        paidRemittances: alreadyPaid.map((r) => r.remitanceId),
      });
    }

    // Step 4: Check if all selected belong to the same user
    const uniqueUsers = [...new Set(remittances.map((r) => String(r.userId)))];

    if (uniqueUsers.length !== 1) {
      return res.status(400).json({
        message: "Selected remittances belong to different users.",
      });
    }

    const userId = uniqueUsers[0];

    // Step 5: Get pending remittances (for debug or UI)
    const pendingRemittances = await adminCodRemittance
      .find({ userId, status: "Pending" })
      .lean();

    const pendingIds = pendingRemittances.map((r) => r.remitanceId);

    // SUCCESS
    return res.status(200).json({
      message: "Validation successful",
      selectedIds: remittanceIds,
      userId,
      pendingIds,
    });
  } catch (error) {
    console.error("Error in validateCODTransfer:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getCODTransferData = async (req, res) => {
  try {
    const { id } = req.params;
    let { selectedRemittanceIds } = req.query;

    if (!id) {
      return res.status(400).json({ message: "User ID is required." });
    }

    // Ensure selectedRemittanceIds is an array
    if (selectedRemittanceIds) {
      if (!Array.isArray(selectedRemittanceIds)) {
        selectedRemittanceIds = [selectedRemittanceIds];
      }
    } else {
      return res.status(400).json({ message: "selectedRemittanceIds are required." });
    }

    if (selectedRemittanceIds.length === 0) {
      return res
        .status(400)
        .json({ message: "selectedRemittanceIds array is required." });
    }

    // Fetch all remittance records for this user
    const remittanceRecords = await codRemittance.find({ userId: id }).lean();

    if (!remittanceRecords || remittanceRecords.length === 0) {
      return res
        .status(404)
        .json({ message: "No remittance data found for this user." });
    }

    // Filter only selected remittance entries
    const filteredRemittance = remittanceRecords
      .map((record) => ({
        ...record,
        remittanceData: record.remittanceData.filter((r) =>
          selectedRemittanceIds.includes(String(r.remittanceId))
        ),
      }))
      .filter((record) => record.remittanceData.length > 0);

    if (filteredRemittance.length === 0) {
      return res.status(404).json({
        message:
          "No matching remittance data found for selected remittance IDs.",
      });
    }

    // Fetch bank details
    const bankDetails = await bankAccount.findOne({ user: id }).lean();

    if (!bankDetails) {
      return res
        .status(404)
        .json({ message: "Bank details not found for this user." });
    }

    // 🔥 Fetch Wallet Balance & Hold Amount
    const user = await User.findById(id).lean();
    if (!user || !user.Wallet) {
      return res
        .status(404)
        .json({ message: "Wallet not found for this user." });
    }

    const wallet = await Wallet.findById(user.Wallet).lean().select("balance holdAmount creditLimit");
    if (!wallet) {
      return res.status(404).json({ message: "Wallet data not found." });
    }

    const walletBalance = wallet.balance || 0;
    const holdAmount = wallet.holdAmount || 0; // adjust field name if different
    const creditLimit = wallet.creditLimit || 0;

    // Return only selected remittance entries
    return res.status(200).json({
      message: "Selected remittance data & bank details fetched successfully",
      bankDetails,
      walletBalance,
      holdAmount,
      creditLimit,
      data: filteredRemittance,
    });
  } catch (error) {
    console.error("Error in getCODTransferData:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// const transferCOD = async (req, res) => {
//   try {
//     const { id } = req.params; // userId
//     const { utr } = req.body;

//     if (!id || !utr) {
//       return res.status(400).json({ message: "User ID and UTR are required." });
//     }

//     // 1. Fetch COD Remittance record for this user
//     const remittanceRecord = await codRemittance.findOne({ userId: id });
//     if (!remittanceRecord) {
//       return res
//         .status(404)
//         .json({ message: "No remittance data found for this user." });
//     }

//     // 2. Find all Pending remittanceData
//     const pendingRemittances = remittanceRecord.remittanceData.filter(
//       (r) => r.status === "Pending"
//     );

//     if (pendingRemittances.length === 0) {
//       return res
//         .status(400)
//         .json({ message: "No pending remittance data found for this user." });
//     }

//     // 3. Remove duplicate remittanceIds
//     const uniquePendingRemittances = [];
//     const seenIds = new Set();

//     for (let r of pendingRemittances) {
//       if (!seenIds.has(r.remittanceId)) {
//         seenIds.add(r.remittanceId);
//         uniquePendingRemittances.push(r);
//       }
//     }

//     // 4. Calculate total sum of COD available (only unique ones)
//     const initiatedSum = uniquePendingRemittances.reduce(
//       (sum, r) => sum + (r.codAvailable || 0),
//       0
//     );

//     // 5. Update remittanceData -> set Paid + utr
//     remittanceRecord.remittanceData = remittanceRecord.remittanceData.map((r) =>
//       r.status === "Pending" && seenIds.has(r.remittanceId)
//         ? { ...r, status: "Paid", utr, remittanceMethod: "Bank Transaction" }
//         : r
//     );

//     // 6. Update summary fields in codRemittance
//     remittanceRecord.LastCODRemitted = initiatedSum;
//     remittanceRecord.RemittanceInitiated =
//       (remittanceRecord.RemittanceInitiated || 0) - initiatedSum;
//     remittanceRecord.TotalCODRemitted =
//       (Number(remittanceRecord.TotalCODRemitted) || 0) + initiatedSum;

//     await remittanceRecord.save();

//     // 7. Update adminCodRemittance for each unique remittanceId
//     for (let rem of uniquePendingRemittances) {
//       await adminCodRemittance.findOneAndUpdate(
//         { remitanceId: rem.remittanceId },
//         { $set: { status: "Paid" } }
//       );
//     }

//     return res.status(200).json({
//       message: "COD transfer completed successfully",
//       utr,
//       remittanceInitiated: initiatedSum,
//       data: remittanceRecord,
//     });
//   } catch (error) {
//     console.error("Error in transferCOD:", error);
//     return res.status(500).json({ message: "Internal server error" });
//   }
// };

const transferCOD = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;

    let {
      utr,
      selectedRemittanceIds = [],
      payableRemittanceIds = [],
      topUpRemittanceIds = [],
      frozenRemittanceIds = [],
      negativeOnlyAdjust = null,
    } = req.body;

    // Normalize IDs
    selectedRemittanceIds = selectedRemittanceIds.map(String);
    payableRemittanceIds = payableRemittanceIds.map(String);
    topUpRemittanceIds = topUpRemittanceIds.map(String);
    frozenRemittanceIds = frozenRemittanceIds.map(String);

    // Fetch user remittance record
    const remRecord = await codRemittance.findOne({ userId: id });
    if (!remRecord) {
      return res
        .status(404)
        .json({ message: "No COD remittance record found" });
    }

    // Fetch user + wallet
    const user = await User.findById(id);
    const wallet = await Wallet.findById(user.Wallet).select("balance");

    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    // Get only pending entries
    const pendingEntries = remRecord.remittanceData.filter(
      (r) => r.status === "Pending"
    );

    let totalPayable = 0;
    let totalAdjusted = 0;

    // ============================================================
    // Process each pending entry
    // ============================================================
    remRecord.remittanceData = remRecord.remittanceData.map((item) => {
      const idStr = String(item.remittanceId);

      // Skip already Paid entries → don't modify them
      if (item.status === "Paid") return item;

      const remAmt = Number(item.codAvailable || 0);

      // 1️⃣ PAYABLE entries → Paid
      if (payableRemittanceIds.includes(idStr)) {
        const codAmt = Number(item.codAvailable || 0);

        // Partial wallet adjustment for "negative only" mode
        if (negativeOnlyAdjust && String(negativeOnlyAdjust.remittanceId) === idStr) {
          const adjustAmt = Math.min(Number(negativeOnlyAdjust.amount) || 0, codAmt);
          totalAdjusted += adjustAmt;
          totalPayable += codAmt - adjustAmt;

          return {
            ...item,
            status: "Paid",
            codAvailable: Number((codAmt - adjustAmt).toFixed(2)),
            adjustedAmount: Number(((item.adjustedAmount || 0) + adjustAmt).toFixed(2)),
            utr,
            remittanceMethod: "Bank Transfer",
            reason: `Paid to client (₹${(codAmt - adjustAmt).toFixed(2)}) & adjusted to wallet (₹${adjustAmt.toFixed(2)})`,
          };
        } else {
          totalPayable += codAmt;
          return {
            ...item,
            status: "Paid",
            utr,
            remittanceMethod: "Bank Transfer",
            reason: "Paid to client",
          };
        }
      }

      // 2️⃣ Wallet Top-Up entries
      if (topUpRemittanceIds.includes(idStr)) {
        totalAdjusted += remAmt;

        return {
          ...item,
          status: "Paid",
          codAvailable: 0,
          adjustedAmount: Number(((item.adjustedAmount || 0) + remAmt).toFixed(2)),
          remittanceMethod: "Wallet Adjustment",
          reason: "Used to adjust negative wallet balance",
        };
      }

      // 3️⃣ Frozen entries → not paid, not topup
      if (frozenRemittanceIds.includes(idStr)) {
        return {
          ...item,
          status: "Pending",
          utr: null,
          remittanceMethod: null,
          reason: "Frozen because negative wallet balance",
        };
      }

      // 4️⃣ Held entries → still pending
      return {
        ...item,
        status: "Pending",
        utr: null,
        remittanceMethod: null,
        reason: "Held due to hold amount requirement",
      };
    });

    // UTR required only when actual money is paid to client
    if (totalPayable > 0 && !utr) {
      return res.status(400).json({
        message: "UTR is required when paying remittances.",
      });
    }

    session.startTransaction();

    // ============================================================
    // WALLET ADJUSTMENT (TopUp)
    // ============================================================
    if (totalAdjusted > 0) {
      const newBalance = wallet.balance + totalAdjusted;

      await Wallet.updateOne(
        { _id: wallet._id },
        { $set: { balance: newBalance } },
        { session }
      );
      await WalletTransaction.create([{
        walletId: wallet._id,
        category: "credit",
        amount: totalAdjusted,
        balanceAfterTransaction: newBalance,
        description: "COD adjustment credited to wallet",
        date: new Date(),
      }], { session });
    }

    // ============================================================
    // Update summary fields
    // ============================================================
    remRecord.LastCODRemitted = totalPayable;
    remRecord.RemittanceInitiated =
      (remRecord.RemittanceInitiated || 0) - totalPayable - totalAdjusted;
    remRecord.TotalCODRemitted =
      (Number(remRecord.TotalCODRemitted) || 0) + totalPayable;
    remRecord.TotalDeductionfromCOD =
      (Number(remRecord.TotalDeductionfromCOD) || 0) + totalAdjusted;

    await remRecord.save({ session });

    // ============================================================
    // Update admin table
    // ============================================================
    for (const remId of selectedRemittanceIds) {
      let status = "Pending";
      let reason = "";
      let updateFields = {};

      const entry = pendingEntries.find((e) => String(e.remittanceId) === remId);
      const originalCodAvailable = entry ? Number(entry.codAvailable || 0) : 0;
      const originalAdjustedAmount = entry ? Number(entry.adjustedAmount || 0) : 0;

      if (payableRemittanceIds.includes(remId)) {
        status = "Paid";
        if (negativeOnlyAdjust && String(negativeOnlyAdjust.remittanceId) === remId) {
          const adjustAmt = Math.min(Number(negativeOnlyAdjust.amount) || 0, originalCodAvailable);
          reason = `Paid to client (₹${(originalCodAvailable - adjustAmt).toFixed(2)}) & adjusted to wallet (₹${adjustAmt.toFixed(2)})`;
          updateFields = {
            totalCod: Number((originalCodAvailable - adjustAmt).toFixed(2)),
            adjustedAmount: Number((originalAdjustedAmount + adjustAmt).toFixed(2)),
          };
        } else {
          reason = "Paid to client";
        }
      } else if (topUpRemittanceIds.includes(remId)) {
        status = "Paid";
        reason = "Used to adjust negative wallet balance";
        updateFields = {
          totalCod: 0,
          adjustedAmount: Number((originalAdjustedAmount + originalCodAvailable).toFixed(2)),
        };
      } else if (frozenRemittanceIds.includes(remId)) {
        status = "Pending";
        reason = "Frozen because negative wallet balance";
      } else {
        status = "Pending";
        reason = "Held for hold amount requirement";
      }

      await adminCodRemittance.findOneAndUpdate(
        { remitanceId: remId },
        {
          $set: { status, reason, ...updateFields },
        },
        { new: true, session }
      );

      // Sync corresponding orders status to Paid in CodRemittanceOrdersModel
      if (status === "Paid" && entry?.orderDetails?.orders) {
        const orderIds = entry.orderDetails.orders.filter(Boolean);
        if (orderIds.length > 0) {
          const orders = await Order.find({ _id: { $in: orderIds } }).session(session).lean().select("orderId awb_number");
          const customOrderIds = orders.map(o => String(o.orderId)).filter(Boolean);
          const awbs = orders.map(o => String(o.awb_number)).filter(Boolean);

          if (customOrderIds.length > 0 || awbs.length > 0) {
            await CodRemittanceOrdersModel.updateMany(
              {
                $or: [
                  { orderID: { $in: customOrderIds } },
                  { AWB_Number: { $in: awbs } }
                ]
              },
              { $set: { status: "Paid" } },
              { session }
            );
          }
        }
      }
    }

    await session.commitTransaction();

    // ============================================================
    // Response
    // ============================================================
    return res.status(200).json({
      success: true,
      message: "COD remittance processed successfully.",
      totalPayable,
      totalAdjusted,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Error in transferCOD:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

const checkOrderDuplicates = async () => {
  try {
    console.log("🔍 Starting comprehensive COD remittance duplicate check...");
    const allRemittances = await codRemittance.find({});
    
    // Map to track: mongoId -> array of occurrences: { userId, remittanceId }
    const orderIdOccurrences = {}; 
    const mongoIds = new Set();

    allRemittances.forEach((doc) => {
      const userId = doc.userId.toString();
      if (doc.remittanceData && Array.isArray(doc.remittanceData)) {
        doc.remittanceData.forEach((remittance) => {
          const remittanceId = remittance.remittanceId;
          if (
            remittance.orderDetails &&
            remittance.orderDetails.orders &&
            Array.isArray(remittance.orderDetails.orders)
          ) {
            remittance.orderDetails.orders.forEach((mId) => {
              if (mId) {
                const mIdStr = mId.toString();
                mongoIds.add(mIdStr);
                
                if (!orderIdOccurrences[mIdStr]) {
                  orderIdOccurrences[mIdStr] = [];
                }
                orderIdOccurrences[mIdStr].push({ userId, remittanceId });
              }
            });
          }
        });
      }
    });

    // Fetch order details for status, method, custom orderId, and awb_number (include paymentDetails.amount)
    const orders = await Order.find(
      { _id: { $in: Array.from(mongoIds) } },
      { orderId: 1, awb_number: 1, status: 1, "paymentDetails.method": 1, "paymentDetails.amount": 1, userId: 1 }
    ).lean();

    const orderDetailsMap = {};
    orders.forEach((o) => {
      orderDetailsMap[o._id.toString()] = o;
    });

    // Grouping by custom orderId and AWB to detect duplicates based on values, not just mongo _ids
    const customOrderIdGroups = {}; // { customOrderId: { mongoId: [{userId, remittanceId}] } }
    const awbGroups = {};           // { awbNumber: { mongoId: [{userId, remittanceId}] } }

    let missingOrdersCount = 0;
    let mismatchesCount = 0;
    let mismatchAmount = 0;
    
    for (const mIdStr of mongoIds) {
      const instances = orderIdOccurrences[mIdStr];
      const orderData = orderDetailsMap[mIdStr];

      if (!orderData) {
        missingOrdersCount++;
        console.log(`⚠️ Remitted Order _id ${mIdStr} not found in Orders collection. Occurrences in Remittances:`, 
          instances.map(i => `(User: ${i.userId}, Rem: ${i.remittanceId})`).join(", ")
        );
        continue;
      }

      const amount = Number(orderData.paymentDetails?.amount || 0);

      // Validate status / method
      const isCOD = orderData.paymentDetails?.method === "COD";
      const isDelivered = orderData.status === "Delivered";
      if (!isCOD || !isDelivered) {
        mismatchesCount++;
        mismatchAmount += amount * instances.length;
        console.log(`❌ Mismatch - OrderId: ${orderData.orderId}, AWB: ${orderData.awb_number}, Status: ${orderData.status}, Method: ${orderData.paymentDetails?.method || "N/A"}, Amount: ₹${amount}. Occurrences:`,
          instances.map(i => `(User: ${i.userId}, Rem: ${i.remittanceId})`).join(", ")
        );
      }

      // Group by custom orderId
      const customId = String(orderData.orderId || "").trim();
      if (customId) {
        if (!customOrderIdGroups[customId]) customOrderIdGroups[customId] = {};
        if (!customOrderIdGroups[customId][mIdStr]) customOrderIdGroups[customId][mIdStr] = [];
        customOrderIdGroups[customId][mIdStr].push(...instances);
      }

      // Group by AWB Number
      const awb = String(orderData.awb_number || "").trim();
      if (awb) {
        if (!awbGroups[awb]) awbGroups[awb] = {};
        if (!awbGroups[awb][mIdStr]) awbGroups[awb][mIdStr] = [];
        awbGroups[awb][mIdStr].push(...instances);
      }
    }

    console.log("\n--- Analyzing Duplicates ---");
    let duplicateReferencesCount = 0;
    let duplicateDocumentsCount = 0;
    let duplicateAmount = 0;

    for (const [customId, mongoIdMap] of Object.entries(customOrderIdGroups)) {
      const mongoIdsForThisCustomId = Object.keys(mongoIdMap);
      
      // 1. Check if the same custom order ID has different physical Mongo IDs remitted (Database Document Duplicates)
      if (mongoIdsForThisCustomId.length > 1) {
        duplicateDocumentsCount++;
        console.log(`🚨 DOCUMENT DUPLICATE: Custom Order ID '${customId}' has ${mongoIdsForThisCustomId.length} different physical order documents in DB:`);
        mongoIdsForThisCustomId.forEach((mId) => {
          const refs = mongoIdMap[mId];
          console.log(`   └─ Mongo ID: ${mId} | Remitted in: ${refs.map(r => `(User: ${r.userId}, Rem: ${r.remittanceId})`).join(", ")}`);
        });
      }

      // 2. Check if a specific Mongo ID is referenced multiple times in remittance records (Reference Duplicates)
      for (const [mId, occurrences] of Object.entries(mongoIdMap)) {
        if (occurrences.length > 1) {
          duplicateReferencesCount++;
          
          const orderData = orderDetailsMap[mId];
          const amount = Number(orderData?.paymentDetails?.amount || 0);
          const extraTimesPaid = occurrences.length - 1;
          duplicateAmount += amount * extraTimesPaid;

          // Check if duplicated inside the exact same remittance
          const remMap = {};
          occurrences.forEach(o => {
            if (!remMap[o.remittanceId]) remMap[o.remittanceId] = 0;
            remMap[o.remittanceId]++;
          });

          const sameRemList = [];
          const diffRemList = [];
          for (const [remId, count] of Object.entries(remMap)) {
            if (count > 1) {
              sameRemList.push(`Remittance ${remId} (referenced ${count} times)`);
            } else {
              diffRemList.push(`Remittance ${remId}`);
            }
          }

          console.log(`⚠️ REFERENCE DUPLICATE: Custom Order ID '${customId}' (Mongo ID: ${mId}) is remitted multiple times (COD Amount: ₹${amount}):`);
          if (sameRemList.length > 0) {
            console.log(`   └─ Inner-Remittance Duplicates: ${sameRemList.join(", ")}`);
          }
          if (diffRemList.length > 0) {
            console.log(`   └─ Cross-Remittance Duplicates: ${diffRemList.join(", ")}`);
          }
        }
      }
    }

    console.log("\n==================================================");
    console.log("📊 DUPLICATE CHECK SUMMARY");
    console.log("==================================================");
    console.log(`🔹 Total Unique Mongo IDs Scanned: ${mongoIds.size}`);
    console.log(`🔹 Missing Orders (Not in Orders DB): ${missingOrdersCount}`);
    console.log(`🔹 Status/Method Mismatches: ${mismatchesCount} (Total Amount: ₹${mismatchAmount.toFixed(2)})`);
    console.log(`🔹 Reference Duplicates (Same order double-remitted): ${duplicateReferencesCount} (Total Amount: ₹${duplicateAmount.toFixed(2)})`);
    console.log(`🔹 Document Duplicates (Different orders sharing same Custom ID): ${duplicateDocumentsCount}`);
    console.log(`🔹 TOTAL INCORRECTLY PAID AMOUNT: ₹${(mismatchAmount + duplicateAmount).toFixed(2)}`);
    console.log("==================================================\n");

  } catch (error) {
    console.error("❌ Error in checkOrderDuplicates:", error);
  }
};

// To run this function manually, you can call it here:
// checkOrderDuplicates();

// ============================================================
// EXPORT BANK TEMPLATE  (supports single AND multi-user bulk)
// Groups selected remittance IDs by userId, runs hold/topup/payable
// logic independently per user, combines all payable rows into one XLSX.
// ============================================================
const exportBankTemplate = async (req, res) => {
  try {
    let { selectedRemittanceIds } = req.query;

    if (!selectedRemittanceIds) {
      return res.status(400).json({ message: "selectedRemittanceIds are required" });
    }

    // Normalize to array
    if (!Array.isArray(selectedRemittanceIds)) {
      selectedRemittanceIds = [selectedRemittanceIds];
    }
    selectedRemittanceIds = selectedRemittanceIds.map(String);

    // Check if any of these remittance IDs are already in an active export batch
    const activeBatches = await BankExportBatch.find({ status: "Active" }).lean();
    const alreadyExportedIds = [];
    for (const batch of activeBatches) {
      for (const row of batch.rows) {
        if (selectedRemittanceIds.includes(String(row.remittanceId))) {
          alreadyExportedIds.push(String(row.remittanceId));
        }
      }
    }

    if (alreadyExportedIds.length > 0) {
      return res.status(400).json({
        message: `Remittance ID(s) ${alreadyExportedIds.join(", ")} are already in an active export batch. Please upload their bank response first.`
      });
    }

    // 1. Load all matching adminCodRemittance records to get userId per remittanceId
    const adminRecords = await adminCodRemittance
      .find({ remitanceId: { $in: selectedRemittanceIds } })
      .lean();

    if (adminRecords.length !== selectedRemittanceIds.length) {
      return res.status(400).json({ message: "Some remittance IDs not found" });
    }

    // Filter out already-paid (warn but don't hard-fail — skip them gracefully)
    const pendingAdminRecords = adminRecords.filter(r => r.status !== "Paid");
    const skippedPaid = adminRecords.length - pendingAdminRecords.length;

    if (pendingAdminRecords.length === 0) {
      return res.status(400).json({ message: "All selected remittances are already Paid" });
    }

    // 2. Group pending remittance IDs by userId
    const userIdToRemittanceIds = {};
    for (const rec of pendingAdminRecords) {
      const uid = String(rec.userId);
      if (!userIdToRemittanceIds[uid]) userIdToRemittanceIds[uid] = [];
      userIdToRemittanceIds[uid].push(String(rec.remitanceId));
    }

    const DEBIT_ACCOUNT = "258800258800"; // Quickpost360 Services Pvt Ltd — IndusInd Bank INDB0000673
    const allTemplateRows = [];
    const internalBatchRows = [];
    let totalHeldCount = 0;
    let totalTopUpCount = 0;
    const userErrors = [];

    // 3. Process each user independently
    for (const [userId, remIdsForUser] of Object.entries(userIdToRemittanceIds)) {

      // Fetch user's codRemittance record
      const remittanceRecord = await codRemittance.findOne({ userId }).lean();
      if (!remittanceRecord) {
        userErrors.push(`No codRemittance record for userId ${userId}`);
        continue;
      }

      // Filter to selected PENDING entries for this user
      const filteredEntries = (remittanceRecord.remittanceData || []).filter(
        r => remIdsForUser.includes(String(r.remittanceId)) && r.status === "Pending"
      );

      if (!filteredEntries.length) continue;

      // Fetch user, wallet, bank details
      const user = await users.findById(userId).lean();
      if (!user) { userErrors.push(`User not found: ${userId}`); continue; }

      const [walletDoc, bankDetails] = await Promise.all([
        Wallet.findById(user.Wallet).lean().select("balance holdAmount"),
        BankAccountDetails.findOne({ user: userId }).lean(),
      ]);

      if (!bankDetails) {
        userErrors.push(`No bank details for user ${user.fullname || userId}`);
        continue;
      }

      const balance = Number(walletDoc?.balance ?? 0);
      const holdAmount = Number(walletDoc?.holdAmount ?? 0);

      // Build remittanceEntries with remittanceAmount = codAvailable
      const remittanceEntries = filteredEntries.map(r => ({
        ...r,
        remittanceAmount: Number(Number(r.codAvailable || 0).toFixed(2)),
      }));

      // HOLD LOGIC (mirrors TransferCODModal holdResolved)
      let heldIds = [];
      if (holdAmount > 0) {
        const sortedAsc = [...remittanceEntries].sort((a, b) => a.remittanceAmount - b.remittanceAmount);
        const single = sortedAsc.find(r => r.remittanceAmount >= holdAmount);
        if (single) {
          heldIds = [String(single.remittanceId || single._id)];
        } else {
          const sortedDesc = [...remittanceEntries].sort((a, b) => b.remittanceAmount - a.remittanceAmount);
          let total = 0;
          for (const r of sortedDesc) {
            heldIds.push(String(r.remittanceId || r._id));
            total += r.remittanceAmount;
            if (total >= holdAmount) break;
          }
        }
      }

      // WALLET TOPUP LOGIC (mirrors TransferCODModal walletTopUp)
      let topUpIds = [];
      if (balance < 0) {
        const needed = Math.abs(balance);
        const available = remittanceEntries.filter(r => !heldIds.includes(String(r.remittanceId || r._id)));
        const sortedAsc = [...available].sort((a, b) => a.remittanceAmount - b.remittanceAmount);
        const single = sortedAsc.find(r => r.remittanceAmount >= needed);
        if (single) {
          topUpIds = [String(single.remittanceId || single._id)];
        } else {
          let sum = 0;
          for (const r of sortedAsc) {
            topUpIds.push(String(r.remittanceId || r._id));
            sum += r.remittanceAmount;
            if (sum >= needed) break;
          }
        }
      }

      // PAYABLE LOGIC — exclude held & topup
      const payableEntries = remittanceEntries.filter(r => {
        const id = String(r.remittanceId || r._id);
        if (heldIds.includes(id)) return false;
        if (topUpIds.includes(id)) return false;
        return true;
      });

      totalHeldCount += heldIds.length;
      totalTopUpCount += topUpIds.length;

      // Build rows for this user's payable entries
      for (const r of payableEntries) {
        allTemplateRows.push({
          "Debit Account Number": DEBIT_ACCOUNT,
          "Payment mode": "NEFT",
          "Amount": Number(r.remittanceAmount.toFixed(2)),
          "Beneficiary Name": bankDetails.nameAtBank || "",
          "Beneficiary Account": bankDetails.accountNumber || "",
          "Beneficiary Bank IFSC": bankDetails.ifsc || "",
          "Remarks": `COD Payment ${String(r.remittanceId || "")}`,
          "Beneficiary LEI": "",
        });

        internalBatchRows.push({
          remittanceId: String(r.remittanceId),
          userId: user._id,
          beneficiaryAccount: bankDetails.accountNumber || "",
          amount: Number(r.remittanceAmount.toFixed(2)),
        });
      }
    }

    let batchId = "";
    if (internalBatchRows.length > 0) {
      batchId = `BATCH_${new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14)}`;
      await BankExportBatch.create({
        batchId,
        rows: internalBatchRows,
        totalRows: internalBatchRows.length,
      });
    }

    return res.status(200).json({
      success: true,
      batchId,
      rows: allTemplateRows,
      payableCount: allTemplateRows.length,
      heldCount: totalHeldCount,
      topUpCount: totalTopUpCount,
      skippedPaid,
      userErrors,
    });

  } catch (error) {
    console.error("Error in exportBankTemplate:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

// ============================================================
// UPLOAD BANK RESPONSE (Hybrid Reconciliation Logic)
// 100% accurate financial matching:
//   1. Tries exact match using "Remarks" / "Reference Number" column.
//      We extract the Remittance ID (e.g., REM12345) from the text.
//   2. Fallback: If no exact ID, matches by Beneficiary Account + Amount.
// ============================================================
const uploadBankResponse = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { rows, selectedRemittanceIds } = req.body;
    // rows = [{ remarks, referenceNumber, utrNumber, beneficiaryName, beneficiaryAccount, amount, status, reason }]

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "No rows provided" });
    }

    // Load remittance IDs belonging to the selected export batch by exact match of selectedRemittanceIds
    let batchRemittanceIds = [];
    let matchedBatchId = "";
    if (selectedRemittanceIds && Array.isArray(selectedRemittanceIds) && selectedRemittanceIds.length > 0) {
      const normalizedIds = selectedRemittanceIds.map(String);
      const batch = await BankExportBatch.findOne({
        status: "Active",
        totalRows: normalizedIds.length,
        "rows.remittanceId": { $all: normalizedIds }
      }).lean();
      if (batch) {
        batchRemittanceIds = (batch.rows || []).map(r => String(r.remittanceId));
        matchedBatchId = batch.batchId;
      }
    }

    const results = [];

    session.startTransaction();

    for (const row of rows) {
      const utrNumber = String(row.utrNumber || "").trim();
      const bankStatus = String(row.status || "").trim().toLowerCase();
      const beneficiaryAccount = String(row.beneficiaryAccount || "").trim();
      const paymentAmount = Number(row.amount || 0);
      const rawRemarks = String(row.remarks || "").trim();
      const rawReference = String(row.referenceNumber || "").trim();

      // Skip non-successful rows (support both "successful" and "success")
      if (bankStatus !== "successful" && bankStatus !== "success") {
        results.push({ beneficiaryAccount, amount: paymentAmount, status: "skipped", reason: `Bank status: ${row.status}` });
        continue;
      }

      if (!beneficiaryAccount) {
        results.push({ beneficiaryAccount, amount: paymentAmount, status: "skipped", reason: "No beneficiary account in row" });
        continue;
      }

      // Step 1: Find the user by their bank account number
      const bankRecord = await BankAccountDetails.findOne({ accountNumber: beneficiaryAccount }).lean();
      if (!bankRecord) {
        results.push({ beneficiaryAccount, amount: paymentAmount, status: "error", reason: `No bank account found for ${beneficiaryAccount}` });
        continue;
      }
      const userId = bankRecord.user;

      // Load user's codRemittance record
      const remRecord = await codRemittance.findOne({ userId });
      if (!remRecord) {
        results.push({ beneficiaryAccount, amount: paymentAmount, status: "error", reason: `No COD remittance record found for user` });
        continue;
      }

      let matchedEntry = null;
      let entryIndex = -1;

      // --- MATCH BY BENEFICIARY ACCOUNT + AMOUNT (±1 tolerance) ---
      // We restrict matching ONLY to selected batch or selected Remittance IDs
      entryIndex = remRecord.remittanceData.findIndex(e => {
        const matchesStatusAndAmount = e.status === "Pending" && Math.abs(Number(e.codAvailable || 0) - paymentAmount) < 1;
        if (!matchesStatusAndAmount) return false;

        // 1. If batchId is used, strictly enforce matching against the batch
        if (batchRemittanceIds.length > 0) {
          return batchRemittanceIds.includes(String(e.remittanceId));
        }

        // 2. Fallback: If no batchId, enforce selectedRemittanceIds
        if (selectedRemittanceIds && Array.isArray(selectedRemittanceIds) && selectedRemittanceIds.length > 0) {
          return selectedRemittanceIds.map(String).includes(String(e.remittanceId));
        }
        return true;
      });

      if (entryIndex !== -1) {
        matchedEntry = remRecord.remittanceData[entryIndex];
      }

      if (entryIndex === -1 || !matchedEntry) {
        results.push({ beneficiaryAccount, amount: paymentAmount, status: "error", reason: `No pending remittance entry found with amount ₹${paymentAmount} matching batch/selection criteria` });
        continue;
      }

      const remittanceId = String(matchedEntry.remittanceId);
      const paidAmount = Number(matchedEntry.codAvailable || 0);

      // Update remittanceData entry in-place
      remRecord.remittanceData[entryIndex] = {
        ...(typeof matchedEntry.toObject === "function" ? matchedEntry.toObject() : matchedEntry),
        status: "Paid",
        utr: utrNumber,
        remittanceMethod: "Bank Transfer",
        reason: "Paid via bank bulk transfer",
      };

      // Update summary fields
      remRecord.LastCODRemitted = paidAmount;
      remRecord.RemittanceInitiated = Math.max(0, (remRecord.RemittanceInitiated || 0) - paidAmount);
      remRecord.TotalCODRemitted = (Number(remRecord.TotalCODRemitted) || 0) + paidAmount;

      await remRecord.save({ session });

      // Sync adminCodRemittance using matched remittanceId
      await adminCodRemittance.findOneAndUpdate(
        { remitanceId: remittanceId },
        {
          $set: {
            status: "Paid",
            utr: utrNumber,
            reason: "Paid via bank bulk transfer",
          },
        },
        { new: true, session }
      );

      // Sync corresponding orders status to Paid in CodRemittanceOrdersModel
      if (matchedEntry?.orderDetails?.orders) {
        const orderIds = matchedEntry.orderDetails.orders.filter(Boolean);
        if (orderIds.length > 0) {
          const orders = await Order.find({ _id: { $in: orderIds } }).session(session).lean().select("orderId awb_number");
          const customOrderIds = orders.map(o => String(o.orderId)).filter(Boolean);
          const awbs = orders.map(o => String(o.awb_number)).filter(Boolean);

          if (customOrderIds.length > 0 || awbs.length > 0) {
            await CodRemittanceOrdersModel.updateMany(
              {
                $or: [
                  { orderID: { $in: customOrderIds } },
                  { AWB_Number: { $in: awbs } }
                ]
              },
              { $set: { status: "Paid" } },
              { session }
            );
          }
        }
      }

      results.push({ beneficiaryAccount, amount: paymentAmount, remittanceId, status: "success", utr: utrNumber });
    }

    await session.commitTransaction();

    const successCount = results.filter(r => r.status === "success").length;
    const skippedCount = results.filter(r => r.status === "skipped").length;
    const errorCount = results.filter(r => r.status === "error").length;

    // Mark export batch as processed if successfully reconciled
    if (matchedBatchId && successCount > 0) {
      await BankExportBatch.findOneAndUpdate({ batchId: matchedBatchId }, { status: "Processed" });
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${rows.length} rows: ${successCount} paid, ${skippedCount} skipped, ${errorCount} errors`,
      successCount,
      skippedCount,
      errorCount,
      results,
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("Error in uploadBankResponse:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  } finally {
    session.endSession();
  }
};

const getBankExportBatches = async (req, res) => {
  try {
    const batches = await BankExportBatch.find({ status: "Active" })
      .sort({ exportedAt: -1 })
      .limit(30)
      .lean();
    return res.status(200).json({ success: true, batches });
  } catch (error) {
    console.error("Error in getBankExportBatches:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

const validateExportedStatus = async (req, res) => {
  try {
    const { selectedRemittanceIds } = req.body;
    if (!selectedRemittanceIds || !Array.isArray(selectedRemittanceIds) || selectedRemittanceIds.length === 0) {
      return res.status(400).json({ message: "No selectedRemittanceIds provided" });
    }

    const normalizedIds = selectedRemittanceIds.map(String);

    // Find if there is an active batch that exactly matches the selected remittance IDs
    const matchingBatch = await BankExportBatch.findOne({
      status: "Active",
      totalRows: normalizedIds.length,
      "rows.remittanceId": { $all: normalizedIds }
    }).lean();

    if (!matchingBatch) {
      return res.status(200).json({
        success: false,
        message: `The selected remittance ID(s) do not exactly match any active exported batch. Please select the exact same remittances that you exported together.`
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error in validateExportedStatus:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

const saveCustomCodPlan = async (req, res) => {
  try {
    const { id } = req.query;
    const userId = id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "User not authenticated" });
    }

    const { planName, codCharge, remittanceDay } = req.body;
    if (!planName || codCharge === undefined || codCharge === null || !remittanceDay) {
      return res.status(400).json({ success: false, error: "planName, codCharge, and remittanceDay are required" });
    }

    let codPlan = await CodPlan.findOne({ user: userId });
    if (codPlan) {
      codPlan.planName = planName;
      codPlan.planCharges = Number(codCharge);
      codPlan.isCustom = true;
      codPlan.remittanceDay = remittanceDay;
      await codPlan.save();
    } else {
      codPlan = new CodPlan({
        user: userId,
        planName,
        planCharges: Number(codCharge),
        isCustom: true,
        remittanceDay,
      });
      await codPlan.save();
    }

    return res.status(200).json({ success: true, message: "Custom COD plan saved successfully", codPlan });
  } catch (error) {
    console.error("Error in saveCustomCodPlan:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// ─── Correct a specific remittance ID based on actual order COD amounts ───
// Call: await correctRemittanceData("84096")          → apply correction
// Call: await correctRemittanceData("84096", true)    → dry run (preview only, no DB changes)
const correctRemittanceData = async (remittanceId, dryRun = false) => {
  const session = await mongoose.startSession();
  try {
    if (!remittanceId) throw new Error("remittanceId is required");

    // 1. Find the codRemittance document containing this remittance entry
    const codRemDoc = await codRemittance.findOne({
      "remittanceData.remittanceId": String(remittanceId),
    });
    if (!codRemDoc) throw new Error(`No codRemittance found for remittanceId ${remittanceId}`);

    // 2. Find the specific remittance entry inside remittanceData array
    const remEntry = codRemDoc.remittanceData.find(
      (r) => String(r.remittanceId) === String(remittanceId)
    );
    if (!remEntry) throw new Error("Remittance entry not found in remittanceData");

    if (remEntry.status === "Paid") {
      throw new Error("Cannot correct a Paid remittance. Bank transfer may have already been made.");
    }

    // 3. Fetch actual unique order documents from the Order collection
    const orderIds = remEntry.orderDetails?.orders || [];
    if (orderIds.length === 0) throw new Error("No order IDs found in this remittance entry");

    const actualOrders = await Order.find({ _id: { $in: orderIds } }).lean().select("paymentDetails");
    const actualTotalCod = Number(
      actualOrders.reduce((sum, o) => sum + Number(o.paymentDetails?.amount || 0), 0).toFixed(2)
    );

    // 4. Fetch the user's COD plan to get planCharges
    const codPlan = await CodPlan.findOne({ user: codRemDoc.userId });
    const planCharges = codPlan?.planCharges || 0;

    // 5. Recalculate using the same processAndRemit logic but with corrected totalCod
    const oldExtraAmount = Number(remEntry.amountCreditedToWallet || 0); // rechargeAmount consumed
    const oldCreditedAmount = Number(remEntry.adjustedAmount || 0);       // wallet negative adjustment — unchanged

    let recalcRemainingRecharge = oldExtraAmount > 0
      ? actualTotalCod - oldExtraAmount
      : actualTotalCod;

    // Wallet adjustment stays the same (negative balance was real)
    // but cap it at the new remainingRecharge in case it's now smaller
    const newCreditedAmount = Math.min(oldCreditedAmount, recalcRemainingRecharge);
    recalcRemainingRecharge -= newCreditedAmount;

    const newCharges = Number(((recalcRemainingRecharge * planCharges) / 100).toFixed(2));
    const newCodAvailable = Number((recalcRemainingRecharge - newCharges).toFixed(2));
    const newTotalDeduction = Number((newCharges + newCreditedAmount + oldExtraAmount).toFixed(2));
    const newTotalCodConsumed = Number((recalcRemainingRecharge + newCreditedAmount).toFixed(2));

    // 6. Calculate deltas vs old values for top-level field adjustments
    const oldCodAvailable = Number(remEntry.codAvailable || 0);
    const oldCharges = Number(remEntry.earlyCodCharges || 0);
    const oldTotalCodConsumed = Number(((oldCodAvailable + oldCharges) + oldCreditedAmount).toFixed(2));

    const deltaTotalCodConsumed = Number((oldTotalCodConsumed - newTotalCodConsumed).toFixed(2));
    const deltaPayoutToClient = Number((oldCodAvailable - newCodAvailable).toFixed(2));
    const deltaTotalDeduction = Number(
      (Number((oldCharges + oldCreditedAmount + oldExtraAmount).toFixed(2)) - newTotalDeduction).toFixed(2)
    );

    // 7. Build the preview/result
    const result = {
      remittanceId,
      userId: codRemDoc.userId,
      ordersFound: actualOrders.length,
      orderIdsStored: orderIds.length,
      missingOrders: orderIds.length - actualOrders.length,
      old: {
        totalCod: Number((oldCodAvailable + oldCharges + oldCreditedAmount + oldExtraAmount).toFixed(2)),
        codAvailable: oldCodAvailable,
        earlyCodCharges: oldCharges,
        adjustedAmount: oldCreditedAmount,
      },
      corrected: {
        totalCod: actualTotalCod,
        codAvailable: newCodAvailable,
        earlyCodCharges: newCharges,
        adjustedAmount: newCreditedAmount,
      },
      topLevelAdjustments: {
        CODToBeRemitted: `+${deltaTotalCodConsumed} (add back over-deducted amount)`,
        RemittanceInitiated: `-${deltaPayoutToClient}`,
        TotalDeductionfromCOD: `-${deltaTotalDeduction}`,
      },
    };

    console.log("📊 correctRemittanceData preview:", JSON.stringify(result, null, 2));

    // If dryRun=true, just return the preview without making any DB changes
    if (dryRun) {
      console.log("🔍 Dry run — no changes made.");
      return { success: true, message: "Dry run — no changes made", result };
    }

    // 8. Apply all corrections atomically in a single transaction
    session.startTransaction();

    // 8a. Update the remittanceData subdocument + top-level counters in codRemittance
    await codRemittance.updateOne(
      { "remittanceData.remittanceId": String(remittanceId) },
      {
        $set: {
          "remittanceData.$.codAvailable": newCodAvailable,
          "remittanceData.$.earlyCodCharges": newCharges,
          "remittanceData.$.adjustedAmount": newCreditedAmount,
          "remittanceData.$.orderDetails.codcal": actualTotalCod,
          "remittanceData.$.status": newCodAvailable === 0 ? "Paid" : "Pending",
        },
        $inc: {
          CODToBeRemitted: deltaTotalCodConsumed,
          RemittanceInitiated: -deltaPayoutToClient,
          TotalDeductionfromCOD: -deltaTotalDeduction,
        },
      },
      { session }
    );

    // 8b. Update the adminCodRemittance entry
    await adminCodRemittance.updateOne(
      { remitanceId: Number(remittanceId) },
      {
        $set: {
          totalCod: newCodAvailable,
          earlyCodCharges: newCharges,
          adjustedAmount: newCreditedAmount,
          status: newCodAvailable === 0 ? "Paid" : "Pending",
        },
      },
      { session }
    );

    await session.commitTransaction();
    console.log(`✅ Remittance ${remittanceId} corrected successfully`);
    return { success: true, message: `Remittance ${remittanceId} corrected successfully`, result };

  } catch (error) {
    await session.abortTransaction();
    console.error("❌ Error in correctRemittanceData:", error.message);
    throw error;
  } finally {
    session.endSession();
  }
};

// ─── To run correction, uncomment one of these lines and save: ───
// correctRemittanceData("84096", true).then(console.log).catch(console.error);  // Dry run
// correctRemittanceData("84096").then(console.log).catch(console.error);         // Apply


module.exports = {
  codPlanUpdate,
  codToBeRemitteds,
  codRemittanceData,
  getCodRemitance,
  codRemittanceRecharge,
  getAdminCodRemitanceData,
  downloadSampleExcel,
  uploadCodRemittance,
  CheckCodplan,
  remittanceTransactionData,
  courierCodRemittance,
  CodRemittanceOrder,
  sellerremittanceTransactionData,
  CourierdownloadSampleExcel,
  uploadCourierCodRemittance,
  exportOrderInRemittance,
  validateCODTransfer,
  getCODTransferData,
  transferCOD,
  exportBankTemplate,
  uploadBankResponse,
  getBankExportBatches,
  validateExportedStatus,
  saveCustomCodPlan,
  correctRemittanceData,
  remittanceScheduleData,
};
