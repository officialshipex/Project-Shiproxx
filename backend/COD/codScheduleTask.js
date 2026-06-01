const cron = require("node-cron");
const CodPlan = require("./codPan.model");
const codRemittance = require("./codRemittance.model");
const Order = require("../models/newOrder.model");
const adminCodRemittance = require("./adminCodRemittance.model");
const users = require("../models/User.model.js");
const Wallet = require("../models/wallet");
const afterPlan = require("./afterPlan.model");
const fs = require("fs");
const csvParser = require("csv-parser");
const ExcelJS = require("exceljs");
const path = require("path");
const xlsx = require("xlsx");
const File = require("../model/bulkOrderFiles.model.js");
const CourierCodRemittance = require("./CourierCodRemittance.js");
const CodRemittanceOrders = require("./CodRemittanceOrder.model.js");
const SameDateDelivered = require("./samedateDelivery.model.js");
// Core function: process remittances (no req/res here)
// console.log("Starting scheduled task for processing COD remittances...");
const processCourierCodRemittance = async () => {
  console.log("Processing Courier COD Remittance...");

  // Step 1: Get all Delivered COD Orders
  const codDeliveredOrders = await Order.aggregate([
    {
      $match: {
        status: "Delivered",
        "paymentDetails.method": "COD",
      },
    },
    {
      $project: {
        orderId: 1,
        userId: 1,
        courierServiceName: 1,
        awb_number: 1,
        paymentDetails: 1,
        tracking: { $slice: [ "$tracking", -1 ] },
        updatedAt: 1,
      },
    },
  ]);

  // Step 2: Get distinct remitted orderIDs
  const remittedOrders = await CourierCodRemittance.distinct("orderID");

  // Step 3: Filter unremitted orders
  const newCodDeliveredOrders = codDeliveredOrders.filter(
    (order) => !remittedOrders.includes(Number(order.orderId))
  );

  // Step 4: Decide what orders to process
  const ordersToProcess =
    remittedOrders.length === 0 ? codDeliveredOrders : newCodDeliveredOrders;

  if (!ordersToProcess.length) {
    console.log("No new COD orders to process.");
    return { success: true, message: "No new COD orders found." };
  }

  // Step 5: Get all unique user IDs to reduce DB calls
  const userIds = [
    ...new Set(ordersToProcess.map((o) => o.userId?.toString())),
  ];
  const usersMap = await users
    .find({ _id: { $in: userIds } })
    .lean()
    .then((docs) =>
      docs.reduce((map, user) => {
        map[user._id.toString()] = user;
        return map;
      }, {})
    );

  // Step 6: Save new remittance records
  for (const order of ordersToProcess) {
    const userData = usersMap[order.userId?.toString()];
    if (!userData) {
      console.warn(`Skipping order ${order.orderId}: User not found`);
      continue;
    }

    const lastTrackingUpdate =
      order.tracking?.length > 0
        ? order.tracking[order.tracking.length - 1]?.StatusDateTime
        : order.updatedAt;

    const exists = await CourierCodRemittance.findOne({
      orderID: Number(order.orderId),
    });
    if (exists) {
      console.log(`Skipping duplicate entry for order ${order.orderId}`);
      continue;
    }

    const newRemittance = new CourierCodRemittance({
      userId: order.userId,
      date: lastTrackingUpdate || new Date(),
      orderID: order.orderId,
      userName: userData.fullname || "",
      PhoneNumber: userData.phoneNumber || "",
      Email: userData.email || "",
      courierServiceName: order.courierServiceName || "",
      AwbNumber: order.awb_number || "",
      CODAmount: Number(order.paymentDetails?.amount) || 0,
      status: "Pending",
    });

    try {
      await newRemittance.save();
    } catch (err) {
      if (err.code === 11000) {
        console.warn(`Skipping duplicate key error on saving CourierCodRemittance for order ${order.orderId}`);
      } else {
        throw err;
      }
    }
  }

  console.log(
    `Processed ${ordersToProcess.length} new COD remittance entries.`
  );

  return {
    success: true,
    message: "Courier COD remittance processed successfully.",
  };
};

// Cron job
if (process.env.NODE_ENV === "production") {
  cron.schedule(
    "0 23 * * *", // Runs every day at 11:00 PM IST
    () => {
      console.log(
        "⏰ Running scheduled COD remittance task at 11 PM IST (production)"
      );
      processCourierCodRemittance();
    },
    {
      scheduled: true,
      timezone: "Asia/Kolkata",
    }
  );
} else {
  console.log(
    "⚙️ COD remittance cron not started (development/local environment)"
  );
}

// processCourierCodRemittance()
const processCodRemittanceOrder = async () => {
  console.log("Processing COD Remittance Orders...");

  // Step 1: Get Delivered COD orders
  const codDeliveredOrders = await Order.aggregate([
    {
      $match: {
        status: "Delivered",
        "paymentDetails.method": "COD",
      },
    },
    {
      $project: {
        orderId: 1,
        userId: 1,
        courierServiceName: 1,
        awb_number: 1,
        paymentDetails: 1,
        tracking: { $slice: [ "$tracking", -1 ] },
        updatedAt: 1,
      },
    },
  ]);
  console.log("COD Delivered Orders:", codDeliveredOrders.length);

  // Step 2: Get already remitted order IDs
  const remittedOrderIds = await CodRemittanceOrders.distinct("orderID");

  // Step 3: Filter out already remitted orders
  const ordersToProcess = codDeliveredOrders.filter(
    (order) => !remittedOrderIds.includes(order.orderId?.toString())
  );

  if (!ordersToProcess.length) {
    console.log("No new COD orders to process.");
    return { success: true, message: "No new COD orders found." };
  }

  // Step 4: Fetch all users at once to avoid N+1 queries
  const userIds = [
    ...new Set(ordersToProcess.map((o) => o.userId?.toString())),
  ];
  const usersMap = await users
    .find({ _id: { $in: userIds } })
    .lean()
    .then((docs) =>
      docs.reduce((map, user) => {
        map[user._id.toString()] = user;
        return map;
      }, {})
    );

  // Step 5: Save new remittance orders
  for (const order of ordersToProcess) {
    const userData = usersMap[order.userId?.toString()];
    if (!userData) {
      console.warn(`Skipping order ${order.orderId}: User not found`);
      continue;
    }

    const lastTrackingUpdate =
      order.tracking?.length > 0
        ? order.tracking[order.tracking.length - 1]?.StatusDateTime
        : order.updatedAt;

    // Avoid duplicates just in case
    const exists = await CodRemittanceOrders.findOne({
      orderID: order.orderId?.toString(),
    });
    if (exists) {
      console.log(`Skipping duplicate entry for order ${order.orderId}`);
      continue;
    }

    const newRemittanceOrder = new CodRemittanceOrders({
      userId: order.userId,
      Date: lastTrackingUpdate || new Date(),
      orderID: order.orderId?.toString(),
      userName: userData.fullname || "",
      PhoneNumber: userData.phoneNumber || "",
      Email: userData.email || "",
      courierProvider: order.courierServiceName || "N/A",
      AWB_Number: order.awb_number || "N/A",
      CODAmount: String(order.paymentDetails?.amount || "0"),
      status: "Pending",
    });

    try {
      await newRemittanceOrder.save();
    } catch (err) {
      if (err.code === 11000) {
        console.warn(`Skipping duplicate key error on saving CodRemittanceOrder for order ${order.orderId}`);
      } else {
        throw err;
      }
    }
  }

  console.log(`Processed ${ordersToProcess.length} COD remittance orders.`);
  return {
    success: true,
    message: "COD remittance orders processed successfully.",
  };
};

// Cron job
if (process.env.NODE_ENV === "production") {
  cron.schedule(
    "30 23 * * *", // At 11:30 PM every day
    () => {
      console.log(
        "⏰ Running scheduled COD remittance task at 11:30 PM IST (production)"
      );
      processCodRemittanceOrder();
    },
    {
      scheduled: true,
      timezone: "Asia/Kolkata",
    }
  );
} else {
  console.log(
    "⚙️ COD remittance cron not started (development/local environment)"
  );
}

// processCodRemittanceOrder();
