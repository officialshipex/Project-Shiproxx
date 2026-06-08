const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const mongoose = require("mongoose");
const AllocatedRole = require("../../../models/allocateRoleSchema");
const { createDelhiveryPickupRequest } = require("../Couriers/AllCouriers/Delhivery/Courier/couriers.controller")

const adminB2BOrders = async (req, res) => {
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
      courier,
      userId,
      page = 1,
      limit = 20,
    } = req.query;

    const filter = {};
    filter.orderType = "B2B";
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
    if (courier) {
      const couriers = courier.split(",").map((c) => c.trim());
      filter.courierServiceName = { $in: couriers };
    }
    if (pickupContactName) {
      const names = pickupContactName.split(",").map((n) => n.trim());
      filter["pickupAddress.contactName"] = { $in: names };
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
          courierServices: [],
          pickupLocations: [],
        });
      }
    } else if (userId) {
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

const userB2BOrders = async (req, res) => {
  try {
    const {
      id,
      status,
      searchQuery,
      orderId,
      awbNumber,
      trackingId,
      paymentType,
      startDate,
      endDate,
    } = req.query;

    // console.log("reqq",req.query)
    let userId;
    if (id) {
      userId = id;
    } else {
      userId = req.user?._id || req.employee?._id;
    }

    // console.log("userId",userId)

    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const andConditions = [{ userId }];

    // Fetch ONLY B2B Orders
    andConditions.push({ orderType: "B2B" });

    if (status && status !== "All") {
      const statusArray = Array.isArray(status)
        ? status
        : status.split(",").map((s) => s.trim());

      andConditions.push({ status: { $in: statusArray } });
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
    if (req.query.courierServiceName) {
      const couriers = req.query.courierServiceName.split(",").map((c) => c.trim());
      andConditions.push({ courierServiceName: { $in: couriers } });
    }

    if (paymentType) {
      andConditions.push({ "paymentDetails.method": paymentType });
    }

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      andConditions.push({ createdAt: { $gte: start, $lte: end } });
    }

    if (req.query.pickupContactName) {
      const names = req.query.pickupContactName.split(",").map((n) => n.trim());
      andConditions.push({
        "pickupAddress.contactName": { $in: names },
      });
    }

    const filter = { $and: andConditions };

    const totalCount = await Order.countDocuments(filter);
    let sortOption = { updatedAt: -1 };
    if (
      filter.status &&
      filter.status.$in &&
      filter.status.$in.includes("new")
    ) {
      sortOption = { createdAt: -1 };
    } else if (filter.status === "new") {
      sortOption = { createdAt: -1 };
    }
    let query = Order.find(filter).sort(sortOption).allowDiskUse(true);
    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    // console.log(orders)
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    const allCourierServices = await Order.aggregate([
      { $match: { userId } },
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

    // Fetch all unique pickup locations for the user (not filtered)
    const allPickupLocations = await Order.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: {
            contactName: "$pickupAddress.contactName",
            // Optionally, you can add _id: "$pickupAddress._id" if needed
          },
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
      pickupLocations: allPickupLocations,
      courierServices: allCourierServices.map((c) => c.courierServiceName),
    });
  } catch (error) {
    console.error("Error fetching paginated orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const generatePickupController = async (req, res) => {
  try {
    const { orderIds } = req.body;
    console.log("order pickup", orderIds)

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ message: "orderIds array is required" });
    }

    const results = [];

    for (const orderId of orderIds) {
      const order = await Order.findById(orderId)
        .populate("pickupAddress")
        .lean();

      if (!order) {
        results.push({
          orderId,
          success: false,
          error: "Order not found",
        });
        continue;
      }

      const provider = order.provider?.toLowerCase().trim();

      let result;

      switch (provider) {
        case "delhivery":
          result = await createDelhiveryPickupRequest(order);
          break;

        default:
          result = {
            orderId,
            success: false,
            error: `Pickup not supported for provider: ${provider}`,
          };
          break;
      }

      results.push(result);
    }

    const hasFailure = results.some((r) => r.success === false);

    res.status(hasFailure ? 207 : 200).json({
      success: !hasFailure,
      message: hasFailure
        ? "Pickup processed with partial failures"
        : "Pickup generated successfully",
      results,
    });
  } catch (error) {
    console.error("Pickup controller error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate pickup request",
    });
  }
};



module.exports = { adminB2BOrders, userB2BOrders, generatePickupController };
