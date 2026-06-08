const Order = require("../models/newOrder.model");
const User = require("../models/User.model");
const mongoose = require("mongoose");
const AllocateRole = require("../models/allocateRoleSchema");

const filterOrdersForEmployee = async (req, res) => {
  try {
    const {
      orderId,
      status,
      awbNumber,
      startDate,
      endDate,
      searchQuery, // <-- add this
      paymentType,
      pickupContactName,
      courierServiceName,
      userId,
      page = 1,
      limit = 20,
    } = req.query;
    // console.log("req", req.query)
    const filter = {};

    // Include only B2C + older orders without orderType
    filter.$or = [{ orderType: "B2C" }, { orderType: { $exists: false } }];

    // Order-level filters
    if (orderId && !isNaN(orderId)) {
      filter.orderId = Number(orderId);
    }

    if (status && status !== "All") {
      const statusArray = Array.isArray(status)
        ? status
        : status.split(",").map((s) => s.trim());

      filter.status = { $in: statusArray };
    }

    if (awbNumber) filter.awb_number = { $regex: awbNumber, $options: "i" };

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    }

    if (paymentType) filter["paymentDetails.method"] = paymentType;
    if (courierServiceName && courierServiceName.length > 0) {
      const couriers = Array.isArray(courierServiceName)
        ? courierServiceName
        : courierServiceName.split(",");

      filter.courierServiceName = {
        $in: couriers.map((c) => c.trim()),
      };
    }

    if (pickupContactName && pickupContactName.length > 0) {
      const names = Array.isArray(pickupContactName)
        ? pickupContactName
        : pickupContactName.split(",");

      filter["pickupAddress.contactName"] = {
        $in: names.map((n) => n.trim()),
      };
    }


    let allocatedUserIds = [];

    // Employee role filtering logic
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });

      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (allocatedUserIds.length === 0) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
    }

    // User filtering logic
    if (userId) {
      const objectId = new mongoose.Types.ObjectId(userId);
      if (
        allocatedUserIds.length > 0 &&
        !allocatedUserIds.includes(userId.toString())
      ) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
      filter.userId = objectId;
    }

    if (searchQuery) {
      const users = await User.find({
        $or: [
          { fullname: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
          { phoneNumber: { $regex: searchQuery, $options: "i" } },
        ],
      }).select("_id");

      const matchedUserIds = users.map((u) => u._id);

      filter.$and = filter.$and || [];

      filter.$and.push({
        $or: [
          { userId: { $in: matchedUserIds } },
          { "receiverAddress.contactName": { $regex: searchQuery, $options: "i" } },
          { "receiverAddress.email": { $regex: searchQuery, $options: "i" } },
          { "receiverAddress.phoneNumber": { $regex: searchQuery, $options: "i" } },
        ],
      });
    }
    else if (userId) {
      const objectId = new mongoose.Types.ObjectId(userId);
      if (
        allocatedUserIds.length > 0 &&
        !allocatedUserIds.includes(userId.toString())
      ) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
      filter.userId = objectId;
    } else if (allocatedUserIds.length > 0) {
      filter.userId = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // Pagination & fetch
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalCount = await Order.countDocuments(filter);
    // Conditional sorting logic
    let sortOption = { shipmentCreatedAt: -1 };
    if (
      filter.status &&
      filter.status.$in &&
      filter.status.$in.includes("new")
    ) {
      sortOption = { createdAt: -1 };
    } else if (filter.status === "new") {
      sortOption = { createdAt: -1 };
    }
    const orders = await Order.find(filter)
      .sort(sortOption)
      .populate("userId", "fullname email phoneNumber company userId")
      .skip(skip)
      .limit(parseInt(limit))
      .allowDiskUse(true)
      .lean();

    const totalPages = Math.ceil(totalCount / limit);

    const matchStage = { ...filter };

    // Aggregation: Couriers
    const couriersData = await Order.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$courierServiceName",
        },
      },
      {
        $project: {
          _id: 0,
          courierServiceName: "$_id",
        },
      },
    ]);

    const couriers = couriersData.map((c) => c.courierServiceName);

    // Aggregation: Pickup Locations
    const pickupLocations = await Order.aggregate([
      {
        $match: {
          ...matchStage,
          "pickupAddress.contactName": { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: { contactName: "$pickupAddress.contactName" },
          address: { $first: "$pickupAddress.address" },
          phoneNumber: { $first: "$pickupAddress.phoneNumber" },
          email: { $first: "$pickupAddress.email" },
          pinCode: { $first: "$pickupAddress.pinCode" },
          city: { $first: "$pickupAddress.city" },
          state: { $first: "$pickupAddress.state" },
        },
      },
      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          address: 1,
          phoneNumber: 1,
          email: 1,
          pinCode: 1,
          city: 1,
          state: 1,
        },
      },
    ]);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: parseInt(page),
      courierServices: couriers,
      pickupLocations,
    });
  } catch (error) {
    console.error("Error filtering orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const filterDelayDeliveredOrders = async (req, res) => {
  try {
    const {
      orderId,
      awbNumber,
      startDate,
      endDate,
      searchQuery,
      paymentType,
      pickupContactName,
      courier,
      userId,
      page = 1,
      limit = 20,
    } = req.query;
    // console.log("req query",req.query)
    const filter = {};

    // --------------------------------------
    // SAME FILTERS AS ORIGINAL (EXCEPT STATUS)
    // --------------------------------------

    if (orderId && !isNaN(orderId)) {
      filter.orderId = Number(orderId);
    }

    if (awbNumber) {
      filter.awb_number = { $regex: awbNumber, $options: "i" };
    }

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    }

    if (paymentType) {
      filter["paymentDetails.method"] = paymentType;
    }

    if (courier) {
      const couriers = courier.split(",").map((c) => c.trim());
      filter.courierServiceName = { $in: couriers };
    }

    if (pickupContactName) {
      const names = pickupContactName.split(",").map((n) => n.trim());
      filter["pickupAddress.contactName"] = { $in: names };
    }

    let allocatedUserIds = [];

    // EMPLOYEE ROLE LOGIC
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });

      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (allocatedUserIds.length === 0) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          couriers: [],
          pickupLocations: [],
        });
      }
    }

    // USER FILTER
    if (userId) {
      const objectId = new mongoose.Types.ObjectId(userId);

      if (allocatedUserIds.length > 0 && !allocatedUserIds.includes(userId)) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          couriers: [],
          pickupLocations: [],
        });
      }

      filter.userId = objectId;
    }

    // GLOBAL SEARCH BY USER (fullname, email, phoneNumber)
    if (searchQuery) {
      const userFilter = {
        $or: [
          { fullname: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
          { phoneNumber: { $regex: searchQuery, $options: "i" } },
        ],
      };

      const users = await User.find(userFilter).select("_id");
      const matchedIds = users.map((u) => u._id.toString());

      let validUserIds = matchedIds;

      if (allocatedUserIds.length > 0) {
        validUserIds = matchedIds.filter((id) => allocatedUserIds.includes(id));
      }

      if (validUserIds.length > 0) {
        filter.userId = {
          $in: validUserIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
      } else {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          couriers: [],
          pickupLocations: [],
        });
      }
    } else if (!userId && allocatedUserIds.length > 0) {
      filter.userId = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // ---------------------------
    // QUERY ORDERS (NO STATUS FILTER)
    // ---------------------------
    const skip = (page - 1) * limit;

    let allOrders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .skip(skip)
      .limit(parseInt(limit))
      .allowDiskUse(true)
      .lean();
    // console.log("hi")
    // -------------------------------------------
    // ⭐ FILTER: DELAY DELIVERED ORDERS ONLY
    // currentDate > estimateDeliveryDate
    // -------------------------------------------
    const now = new Date();
    // console.log("now",now)

    const delayedOrders = allOrders.filter((order) => {
      if (!order.estimatedDeliveryDate) return false;
      return now > new Date(order.estimatedDeliveryDate);
    });
    // console.log("delayed",delayedOrders)

    const totalCount = delayedOrders.length;
    const totalPages = Math.ceil(totalCount / limit);

    const paginatedOrders = delayedOrders.slice(skip, skip + parseInt(limit));

    // -------------------------------------
    // COURIERS LIST (BASED ON DELAYED ORDERS ONLY)
    // -------------------------------------
    const couriersSet = new Set();
    delayedOrders.forEach((ord) => {
      if (ord.courierServiceName) couriersSet.add(ord.courierServiceName);
    });

    const couriers = [...couriersSet];

    // -------------------------------------
    // PICKUP LOCATIONS (BASED ON DELAYED ORDERS ONLY)
    // -------------------------------------
    const pickupMap = new Map();

    delayedOrders.forEach((ord) => {
      if (ord.pickupAddress?.contactName) {
        pickupMap.set(ord.pickupAddress.contactName, {
          contactName: ord.pickupAddress.contactName,
          address: ord.pickupAddress.address,
          phoneNumber: ord.pickupAddress.phoneNumber,
          email: ord.pickupAddress.email,
          pinCode: ord.pickupAddress.pinCode,
          city: ord.pickupAddress.city,
          state: ord.pickupAddress.state,
        });
      }
    });

    const pickupLocations = [...pickupMap.values()];

    // FINAL RESPONSE (SAME FORMAT)
    res.json({
      orders: paginatedOrders,
      totalPages,
      totalCount,
      currentPage: parseInt(page),
      courierServices: couriers,
      pickupLocations,
    });
  } catch (err) {
    console.error("Error in filterDelayDeliveredOrders:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

const filterNdrOrdersForEmployee = async (req, res) => {
  try {
    const {
      orderId,
      awbNumber,
      ndrStatus,
      status,
      tab,
      courierServiceName,
      startDate,
      endDate,
      userId,
      searchQuery,
      name,
      email,
      contactNumber,
      paymentType,
      pickupContactName,
      page = 1,
      limit = 20,
    } = req.query;
    // console.log("Query Params:", req.query);
    const filter = {};

    // ⭐ Special logic when action=Action_Requested
    if (tab === "Action_Required") {
      filter.reattempt = true; // Shipment eligible for RE-ATTEMPT
      filter.ndrStatus = "Undelivered"; // Must be Undelivered
    } else if (tab === "Action_Requested") {
      filter.ndrStatus = "Action_Requested";
    } else if (tab === "Delivered") {
      filter.status = "Delivered";
    } else if (tab === "RTO") {
      filter.status = "RTO";
    }

    // Order ID
    if (orderId) {
      if (!isNaN(orderId)) {
        filter.orderId = Number(orderId);
      } else {
        filter.orderId = { $regex: orderId, $options: "i" };
      }
    }

    // AWB Number
    if (awbNumber) {
      filter.awb_number = { $regex: awbNumber, $options: "i" };
    }

    // Payment Type
    if (paymentType) {
      filter["paymentDetails.method"] = paymentType;
    }

    // NDR Status
    if (ndrStatus && ndrStatus !== "All") {
      filter.ndrStatus = ndrStatus;
    }

    // Order Status
    if (status && status !== "All") {
      filter.status = status;
    }

    // Courier
    if (courierServiceName && courierServiceName.length > 0) {
      const couriers = Array.isArray(courierServiceName)
        ? courierServiceName
        : courierServiceName.split(",");

      filter.courierServiceName = {
        $in: couriers.map((c) => c.trim()),
      };
    }

    // Pickup Address
    if (pickupContactName && pickupContactName.length > 0) {
      const names = Array.isArray(pickupContactName)
        ? pickupContactName
        : pickupContactName.split(",");

      filter["pickupAddress.contactName"] = {
        $in: names.map((n) => n.trim()),
      };
    }


    // Date Range (Filter based on when NDR happened)
    if (startDate && endDate) {
      const start = new Date(startDate);
      const endDateObj = new Date(endDate);
      endDateObj.setHours(23, 59, 59, 999);
      filter.$or = [
        { "ndrReason.date": { $gte: start, $lte: endDateObj } },
        {
          $and: [
            { "ndrReason.date": { $exists: false } },
            { createdAt: { $gte: start, $lte: endDateObj } },
          ],
        },
      ];
    }

    // Employee Allocated Users
    let allocatedUserIds = null;
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (allocatedUserIds.length === 0) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
    }

    // User filtering logic (userId OR searchQuery-based match)
    if (searchQuery) {
      const userFilter = {
        $or: [
          { fullname: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
          { phoneNumber: { $regex: searchQuery, $options: "i" } },
        ],
      };

      const users = await User.find(userFilter).select("_id");
      const matchedIds = users.map((u) => u._id.toString());

      let validUserIds = matchedIds;
      if (allocatedUserIds) {
        validUserIds = matchedIds.filter((id) => allocatedUserIds.includes(id));
      }

      if (validUserIds.length > 0) {
        filter.userId = {
          $in: validUserIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
      } else {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
    } else if (userId) {
      const userObjId = new mongoose.Types.ObjectId(userId);
      if (
        allocatedUserIds &&
        !allocatedUserIds.includes(userObjId.toString())
      ) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: parseInt(page),
          courierServices: [],
          pickupLocations: [],
        });
      }
      filter.userId = userObjId;
    } else if (allocatedUserIds) {
      filter.userId = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalCount = await Order.countDocuments(filter);

    const orders = await Order.find(filter)
      .sort({ "ndrReason.date": -1, createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .skip(skip)
      .limit(parseInt(limit))
      .allowDiskUse(true)
      .lean();

    const totalPages = Math.ceil(totalCount / limit);

    // Courier options
    const courierServices = await Order.aggregate([
      { $match: filter },
      { $group: { _id: "$courierServiceName" } },
      { $project: { _id: 0, courierServiceName: "$_id" } },
    ]);

    // Pickup addresses
    const pickupLocations = await Order.aggregate([
      {
        $match: {
          ...filter,
          "pickupAddress.contactName": { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: { contactName: "$pickupAddress.contactName" },
          address: { $first: "$pickupAddress.address" },
          phoneNumber: { $first: "$pickupAddress.phoneNumber" },
          email: { $first: "$pickupAddress.email" },
          pinCode: { $first: "$pickupAddress.pinCode" },
          city: { $first: "$pickupAddress.city" },
          state: { $first: "$pickupAddress.state" },
        },
      },
      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          address: 1,
          phoneNumber: 1,
          email: 1,
          pinCode: 1,
          city: 1,
          state: 1,
        },
      },
    ]);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: parseInt(page),
      courierServices: courierServices.map((c) => c.courierServiceName),
      pickupLocations,
    });
  } catch (error) {
    console.error("Error filtering employee NDR orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getAllOrdersByManualRtoStatusForEmployee = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const status = req.query.status;
    const userId = req.query.userId;

    const filter = {};
    if (status && status !== "All") {
      filter.manualRTOStatus = status;
    }

    // Check if employee context
    let allocatedUserIds = null;
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });

      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (allocatedUserIds.length === 0) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: page,
          couriers: [], // Include couriers in the response
        });
      }
    }

    if (userId) {
      const userObjId = new mongoose.Types.ObjectId(userId);
      if (
        allocatedUserIds &&
        !allocatedUserIds.includes(userObjId.toString())
      ) {
        return res.json({
          orders: [],
          totalPages: 0,
          totalCount: 0,
          currentPage: page,
          couriers: [], // Include couriers in the response
        });
      }
      filter.userId = userObjId;
    } else if (allocatedUserIds) {
      // Apply allocation filter only if employee context and no specific userId
      filter.userId = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter)
      .sort({ "ndrReason.date": -1, createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .allowDiskUse(true);

    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;
    // Fetch all unique couriers
    const couriers = await Order.distinct("courierServiceName");

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      courierServices: couriers, // Use consistent key
    });
  } catch (error) {
    console.error("Error fetching Manual RTO orders (Employee):", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getOrdersByStatus = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const {
      status,
      selectedUserId,
      searchQuery,
      orderId,
      awbNumber,
      trackingId,
      paymentType,
      startDate,
      endDate,
      courierServiceName,
      pickupContactName,
    } = req.query;
    // console.log("rere", req.query);
    const andConditions = [];

    if (
      selectedUserId?.trim() &&
      mongoose.Types.ObjectId.isValid(selectedUserId.trim())
    ) {
      andConditions.push({
        userId: new mongoose.Types.ObjectId(selectedUserId.trim()),
      });
    }

    if (status && status !== "All") {
      andConditions.push({ status });
    }

    if (searchQuery) {
      andConditions.push({
        $or: [
          {
            "receiverAddress.contactName": {
              $regex: searchQuery,
              $options: "i",
            },
          },
          { "receiverAddress.email": { $regex: searchQuery, $options: "i" } },
          {
            "receiverAddress.phoneNumber": {
              $regex: searchQuery,
              $options: "i",
            },
          },
        ],
      });
    }

    if (orderId) {
      const orderIdNum = parseInt(orderId);
      if (!isNaN(orderIdNum)) {
        andConditions.push({ orderId: orderIdNum });
      }
    }

    if (awbNumber) {
      andConditions.push({ awb_number: { $regex: awbNumber, $options: "i" } });
    }

    if (trackingId) {
      andConditions.push({ trackingId: { $regex: trackingId, $options: "i" } });
    }

    if (courierServiceName) {
      const couriers = courierServiceName.split(",").map((c) => c.trim());
      andConditions.push({ courierServiceName: { $in: couriers } });
    }

    if (paymentType) {
      andConditions.push({ "paymentDetails.method": paymentType });
    }

    if (startDate && endDate) {
      andConditions.push({
        createdAt: {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        },
      });
    }

    if (pickupContactName) {
      const names = pickupContactName.split(",").map((n) => n.trim());
      andConditions.push({ "pickupAddress.contactName": { $in: names } });
    }

    const filter = andConditions.length ? { $and: andConditions } : {};

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter)
      .sort({ createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .allowDiskUse(true);

    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    // Convert $and conditions into a flat $match object for aggregation
    const matchStage = filter.$and
      ? filter.$and.reduce((acc, curr) => ({ ...acc, ...curr }), {})
      : {};

    // 🚚 Get courier services based on same filters (status + others)
    const courierServices = await Order.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$courierServiceName",
        },
      },
      {
        $project: {
          _id: 0,
          courierServiceName: "$_id",
        },
      },
    ]);

    // 🏠 Get pickup locations based on same filters (status + others)
    const pickupLocations = await Order.aggregate([
      {
        $match: {
          ...matchStage,
          "pickupAddress.contactName": { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: { contactName: "$pickupAddress.contactName" },
          address: { $first: "$pickupAddress.address" },
          phoneNumber: { $first: "$pickupAddress.phoneNumber" },
          email: { $first: "$pickupAddress.email" },
          pinCode: { $first: "$pickupAddress.pinCode" },
          city: { $first: "$pickupAddress.city" },
          state: { $first: "$pickupAddress.state" },
        },
      },
      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          address: 1,
          phoneNumber: 1,
          email: 1,
          pinCode: 1,
          city: 1,
          state: 1,
        },
      },
    ]);
    // console.log("cour",courierServices)
    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      courierServices: courierServices.map((c) => c.courierServiceName),
      pickupLocations,
    });
  } catch (error) {
    console.error("Error fetching orders by status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const searchUser = async (req, res) => {
  const { query } = req.query;

  if (!query || query.trim() === "") {
    return res.status(400).json({ message: "Query parameter is required." });
  }

  try {
    const escapeRegex = (string) =>
      string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const safeQuery = escapeRegex(query.trim());
    const regex = new RegExp(safeQuery, "i");

    const conditions = [
      { fullname: regex },
      { email: regex },
      { phoneNumber: regex },
    ];

    if (!isNaN(query)) {
      conditions.push({ userId: Number(query) });
    }

    const users = await User.find({ $or: conditions }).select(
      "fullname email phoneNumber _id userId"
    );

    res.json({ users });
  } catch (err) {
    console.error("Error while searching users:", err);
    res.status(500).json({ message: "Error searching users" });
  }
};

const getAllOrdersByNdrStatus = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const {
      status,
      selectedUserId,
      searchQuery,
      orderId,
      awbNumber,
      trackingId,
      paymentType,
      startDate,
      endDate,
      courierServiceName,
      pickupContactName,
    } = req.query;
    console.log("ne", req.query);
    const andConditions = [];

    if (status && status !== "All") {
      andConditions.push({ ndrStatus: status });
    }

    if (selectedUserId && mongoose.Types.ObjectId.isValid(selectedUserId)) {
      andConditions.push({
        userId: new mongoose.Types.ObjectId(selectedUserId),
      });
    }

    if (searchQuery) {
      andConditions.push({
        $or: [
          {
            "receiverAddress.contactName": {
              $regex: searchQuery,
              $options: "i",
            },
          },
          { "receiverAddress.email": { $regex: searchQuery, $options: "i" } },
          {
            "receiverAddress.phoneNumber": {
              $regex: searchQuery,
              $options: "i",
            },
          },
        ],
      });
    }

    if (orderId) {
      const orderIdNum = parseInt(orderId);
      if (!isNaN(orderIdNum)) {
        andConditions.push({ orderId: orderIdNum });
      }
    }

    if (awbNumber) {
      andConditions.push({ awb_number: { $regex: awbNumber, $options: "i" } });
    }

    if (trackingId) {
      andConditions.push({ trackingId: { $regex: trackingId, $options: "i" } });
    }

    if (courierServiceName) {
      const couriers = courierServiceName.split(",").map((c) => c.trim());
      andConditions.push({ courierServiceName: { $in: couriers } });
    }

    if (paymentType) {
      andConditions.push({ "paymentDetails.method": paymentType });
    }

    if (startDate && endDate) {
      andConditions.push({
        createdAt: {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        },
      });
    }

    if (pickupContactName) {
      const names = pickupContactName.split(",").map((n) => n.trim());
      andConditions.push({ "pickupAddress.contactName": { $in: names } });
    }

    const filter = andConditions.length ? { $and: andConditions } : {};

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter)
      .sort({ "ndrReason.date": -1, createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .allowDiskUse(true);

    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    // Convert filter for aggregation use
    const matchStage = filter.$and
      ? filter.$and.reduce((acc, curr) => ({ ...acc, ...curr }), {})
      : {};

    // 🚚 Get courier services based on NDR filters
    const courierServices = await Order.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$courierServiceName",
        },
      },
      {
        $project: {
          _id: 0,
          courierServiceName: "$_id",
        },
      },
    ]);

    // 🏠 Get pickup locations based on NDR filters
    const pickupLocations = await Order.aggregate([
      {
        $match: {
          ...matchStage,
          "pickupAddress.contactName": { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: { contactName: "$pickupAddress.contactName" },
          address: { $first: "$pickupAddress.address" },
          phoneNumber: { $first: "$pickupAddress.phoneNumber" },
          email: { $first: "$pickupAddress.email" },
          pinCode: { $first: "$pickupAddress.pinCode" },
          city: { $first: "$pickupAddress.city" },
          state: { $first: "$pickupAddress.state" },
        },
      },
      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          address: 1,
          phoneNumber: 1,
          email: 1,
          pinCode: 1,
          city: 1,
          state: 1,
        },
      },
    ]);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      courierServices: courierServices.map((c) => c.courierServiceName),
      pickupLocations,
    });
  } catch (error) {
    console.error("Error fetching NDR orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getAllOrdersByManualRtoStatus = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const status = req.query.status;
    const userId = req.query.userId; // ✅ Accept userId from query if provided

    const filter = {};
    if (status && status !== "All") {
      filter.manualRTOStatus = status;
    }

    if (userId) {
      filter.userId = new mongoose.Types.ObjectId(userId);
    }

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter)
      .sort({ "ndrReason.date": -1, createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .allowDiskUse(true);

    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      courierServices: [], // Added for consistency
      pickupLocations: [],
    });
  } catch (error) {
    console.error("Error fetching NDR orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const filterOrders = async (req, res) => {
  try {
    const {
      orderId,
      status,
      awbNumber,
      startDate,
      endDate,
      name,
      email,
      contactNumber,
      type,
      courier,
      userId,
      page = 1,
      limit = 20,
    } = req.query;
    // console.log(startDate, endDate);

    const filter = {};

    if (orderId) {
      if (!isNaN(orderId)) {
        filter.orderId = Number(orderId);
      }
    }
    if (status && status !== "All") filter.status = status;
    if (awbNumber) filter.awb_number = { $regex: awbNumber, $options: "i" };
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999); // Include full end day

      filter.createdAt = {
        $gte: start,
        $lte: end,
      };
    }

    if (type) filter["paymentDetails.method"] = type;
    if (courier) {
      const couriers = courier.split(",").map((c) => c.trim());
      filter.courierServiceName = { $in: couriers };
    }
    if (userId) {
      filter.userId = new mongoose.Types.ObjectId(userId);
    } else if (name || email || contactNumber) {
      // Only run this if userId is NOT set
      let userIds = [];
      const userFilter = {};
      if (name) {
        // If name is a number, search both fullname and phoneNumber
        if (!isNaN(name)) {
          userFilter.$or = [
            { fullname: { $regex: name, $options: "i" } },
            { phoneNumber: { $regex: name, $options: "i" } },
          ];
        } else {
          userFilter.fullname = { $regex: name, $options: "i" };
        }
      }
      if (email) userFilter.email = { $regex: email, $options: "i" };
      if (contactNumber)
        userFilter.phoneNumber = { $regex: contactNumber, $options: "i" };
      console.log("User filter:", userFilter);
      const users = await User.find(userFilter).select("_id");
      console.log("Matched users:", users);
      userIds = users.map((u) => u._id);
      if (userIds.length > 0) filter.userId = { $in: userIds };
      else filter.userId = null; // No match
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter)
      .sort({ createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .allowDiskUse(true);

    query = query.skip(skip).limit(parseInt(limit));

    const orders = await query.lean();
    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: parseInt(page),
      courierServices: [],
      pickupLocations: [],
    });
  } catch (error) {
    console.error("Error filtering orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const filterNdrOrders = async (req, res) => {
  try {
    const {
      orderId,
      awbNumber,
      ndrStatus,
      status,
      courier,
      startDate,
      endDate,
      name,
      email,
      contactNumber,
      userId,
      paymentType,
      page = 1,
      limit = 20,
    } = req.query;

    console.log(startDate, endDate);

    const filter = {};

    if (orderId) {
      if (!isNaN(orderId)) {
        filter.orderId = Number(orderId);
      } else {
        filter.orderId = { $regex: orderId, $options: "i" };
      }
    }
    if (awbNumber) filter.awb_number = { $regex: awbNumber, $options: "i" };
    if (paymentType) {
      filter["paymentDetails.method"] = paymentType;
    }
    if (ndrStatus && ndrStatus !== "All") filter.ndrStatus = ndrStatus;
    if (status && status !== "All") filter.status = status; // <-- add this line
    if (courier) {
      const couriers = courier.split(",").map((c) => c.trim());
      filter.courierServiceName = { $in: couriers };
    }
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999); // Include full end day

      filter.createdAt = {
        $gte: start,
        $lte: end,
      };
    }

    if (userId) {
      filter.userId = new mongoose.Types.ObjectId(userId);
    } else if (name || email || contactNumber) {
      let userIds = [];
      const userFilter = {};
      if (name) userFilter.fullname = { $regex: name, $options: "i" };
      if (email) userFilter.email = { $regex: email, $options: "i" };
      if (contactNumber)
        userFilter.phoneNumber = { $regex: contactNumber, $options: "i" };
      const users = await User.find(userFilter).select("_id");
      userIds = users.map((u) => u._id);
      if (userIds.length > 0) filter.userId = { $in: userIds };
      else filter.userId = null;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter)
      .sort({ createdAt: -1 })
      .populate("userId", "fullname email phoneNumber company userId")
      .allowDiskUse(true);

    query = query.skip(skip).limit(parseInt(limit));

    const orders = await query.lean();
    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: parseInt(page),
    });
  } catch (error) {
    console.error("Error filtering NDR orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  filterOrders,
  filterNdrOrders,
  getOrdersByStatus,
  searchUser,
  getAllOrdersByNdrStatus,
  getAllOrdersByManualRtoStatus,
  filterOrdersForEmployee,
  filterDelayDeliveredOrders,
  filterNdrOrdersForEmployee,
  getAllOrdersByManualRtoStatusForEmployee,
};
