const Order = require("../models/newOrder.model"); // Adjust the path to your model
const { generateUniqueOrderIds } = require("../utils/generateUniqueOrderId");
const user = require("../models/User.model");
const pickAddress = require("../models/pickupAddress.model");
const receiveAddress = require("../models/deliveryAddress.model");
const Courier = require("../models/AllCourierSchema");
const CourierService = require("../models/CourierService.Schema");
const Plan = require("../models/Plan.model");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const EDDMap = require("../models/EDDMap.model");
const EPDMap = require("../models/EPDMap.model");
const { getZone } = require("../Rate/zoneManagementController");
const path = require("path");
const { codToBeRemitted } = require("../COD/cod.controller");
const {
  cancelShipmentforward,
  shipmentTrackingforward,
} = require("../AllCouriers/EcomExpress/Couriers/couriers.controllers");
const {
  pickup,
  cancelShipmentXpressBees,
  trackShipment,
} = require("../AllCouriers/Xpressbees/MainServices/mainServices.controller");
const {
  trackShipmentDelhivery,
  cancelOrderDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  cancelShipment,
  getShipmentTracking,
} = require("../AllCouriers/Amazon/Courier/couriers.controller");
const {
  cancelOrderShreeMaruti,
  trackOrderShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/couriers.controller");
const {
  cancelSmartshipOrder,
} = require("../AllCouriers/SmartShip/Couriers/couriers.controller");
const { checkServiceabilityAll } = require("./shipment.controller");
const { calculateRateForService } = require("../Rate/calculateRateController");
const csv = require("csv-parser");
const fs = require("fs");
const mongoose = require("mongoose");
const {
  cancelOrderDTDC,
  trackOrderDTDC,
} = require("../AllCouriers/DTDC/Courier/couriers.controller");
const {
  cancelVamashipOrder,
} = require("../AllCouriers/Vamaship/Couriers/couriers.controller");
const {
  cancelOrderZipypost,
} = require("../AllCouriers/Zipypost/Couriers/couriers.controller");
const {
  cancelShipmentEkart,
} = require("../AllCouriers/Ekart/Couriers/couriers.controller");
const {
  cancelOrderBoxdLogistics,
} = require("../AllCouriers/BoxdLogistics/Courier/couriers.controller");
const {
  cancelProshipOrder,
  trackProshipOrder,
} = require("../AllCouriers/Proship/Courier/couriers.controller");
const {
  removeFromPickupManifest,
} = require("./scheduledPickup.controller");
const {
  cancelOrder: cancelShiprocketOrder,
} = require("../AllCouriers/ShipRocket/Courier/couriers.controller");
const { cancelShadowfaxOrder } = require("../AllCouriers/Shadowfax/Courier/couriers.controller");
const WeightDiscrepancy = require("../WeightDispreancy/weightDispreancy.model");
// Create a shipment
const newOrder = async (req, res) => {
  try {
    const {
      pickupAddress,
      receiverAddress,
      productDetails,
      packageDetails,
      paymentDetails,
      otherDetails,
      orderType,
      B2BPackageDetails,
      // commodityId,
    } = req.body;
    // console.log(req.body);

    // Validate request data
    if (
      !pickupAddress ||
      !receiverAddress ||
      !productDetails ||
      !packageDetails ||
      !paymentDetails
      // !commodityId
    ) {
      return res.status(400).json({ error: "Alll fields are required" });
    }
    const User = await user.findById(req.user._id);
    if (User.kycDone !== true) {
      return res
        .status(400)
        .json({ error: "Please complete KYC to create an order" });
    }
    if (!["COD", "Prepaid"].includes(paymentDetails.method)) {
      return res.status(400).json({ error: "Invalid payment method" });
    }

    if (!productDetails || !Array.isArray(productDetails) || productDetails.length === 0) {
      return res.status(400).json({ error: "At least one product is required" });
    }

    const computedTotal = productDetails.reduce((sum, p) => {
      const qty = Number(p.quantity) || 1;
      const price = Number(p.unitPrice) || 0;
      return sum + qty * price;
    }, 0);

    const declaredAmount = Number(paymentDetails.amount) || 0;

    if (Math.abs(computedTotal - declaredAmount) > 0.01) {
      return res.status(400).json({
        error: `Payment amount mismatch: declared ₹${declaredAmount} but product total is ₹${computedTotal}`,
      });
    }

    // Generate a unique order ID
    const orderId = await generateUniqueOrderIds(1);
    const compositeOrderId = `${req.user._id}-${orderId}`;
    // Create a new shipment
    const shipment = new Order({
      userId: req.user._id,
      orderId, // Store the generated order ID
      pickupAddress,
      receiverAddress,
      productDetails,
      packageDetails,
      paymentDetails,
      otherDetails,
      compositeOrderId,
      status: "new",
      channel: "custom",
      orderType,
      B2BPackageDetails,
      // commodityId: commodityId,
      tracking: [
        {
          status: "new",
          StatusLocation: pickupAddress.city || "N/A",
          StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
          Instructions: "Order created successfully",
        },
      ],
    });

    // Save to the database
    await shipment.save();

    res.status(201).json({
      message: "Shipment created successfully",
      shipment,
    });
  } catch (error) {
    console.log("1111111111", error);
    res.status(400).json({ error: "All fields are required" });
  }
};
// new pick up address

const updatePackageDetails = async (req, res) => {
  try {
    const { length, width, height, weight } = req.body.details;
    const selectedOrders = req.body.selectedOrders;
    // console.log("re", req.body);

    if (
      length == null ||
      width == null ||
      height == null ||
      weight == null ||
      !Array.isArray(selectedOrders)
    ) {
      return res
        .status(400)
        .json({ message: "Missing or invalid required fields." });
    }

    const validOrderIds = selectedOrders.filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    );

    if (validOrderIds.length === 0) {
      return res.status(400).json({ message: "No valid order IDs provided." });
    }

    const parsedLength = parseFloat(length);
    const parsedWidth = parseFloat(width);
    const parsedHeight = parseFloat(height);
    const parsedWeight = parseFloat(weight);

    const volumetricWeight = (parsedLength * parsedWidth * parsedHeight) / 5000;
    const applicableWeight = Math.max(parsedWeight, volumetricWeight);

    await Order.updateMany(
      { _id: { $in: validOrderIds } },
      {
        $set: {
          packageDetails: {
            deadWeight: parsedWeight,
            applicableWeight: parseFloat(applicableWeight.toFixed(2)),
            volumetricWeight: {
              length: parsedLength,
              width: parsedWidth,
              height: parsedHeight,
              calculatedWeight: parseFloat(volumetricWeight.toFixed(2)),
            },
          },
        },
      },
    );

    return res
      .status(200)
      .json({ message: "Package details updated successfully." });
  } catch (error) {
    console.error("Error updating package details:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
};

const newPickupAddress = async (req, res) => {
  try {
    // console.log(req.body); // To log the incoming request body
    const userId =
      req.query.userId &&
        req.query.userId !== "undefined" &&
        req.query.userId.trim() !== ""
        ? req.query.userId.trim()
        : req.user?._id?.toString();

    // Create a new shipment instance, where pickupAddress is a sub-document
    const shipment = new pickAddress({
      userId: userId, // ✅ Prefer userId from query if provided
      pickupAddress: {
        contactName: req.body.contactName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        address: req.body.address || "",
        pinCode: req.body.pinCode,
        city: req.body.city,
        state: req.body.state,
      },
    });

    // Save the shipment with the pickup address
    await shipment.save();

    res.status(201).json({
      success: true,
      message: "Pickup address saved successfully!",
      data: shipment,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Server error while saving pickup address",
    });
  }
};

const newReciveAddress = async (req, res) => {
  try {
    // console.log(req.body); // To log the incoming request body

    // Create a new shipment instance, where receiverAddress is a sub-document
    const shipment = new receiveAddress({
      userId: req.user._id, // Assuming req.user._id is populated via authentication middleware
      receiverAddress: {
        contactName: req.body.contactName,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        address: req.body.address || "", // Default to empty string if not provided
        pinCode: req.body.pinCode,
        city: req.body.city,
        state: req.body.state,
      },
    });

    // console.log(shipment)

    // Save the shipment with the receiver address
    await shipment.save();

    res.status(201).json({
      success: true,
      message: "Receiver address saved successfully!",
      data: shipment,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Server error while saving receiver address",
    });
  }
};

const deletePickupAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user?.isAdmin === true && req.user?.adminTab === true;
    const isEmployee = req.isEmployee === true || !!req.employee;

    let query = { _id: id };
    if (!isAdmin && !isEmployee) {
      query.userId = req.user?._id;
    }

    // Find the pickup address and ensure it belongs to the user
    const pickupAddress = await pickAddress.findOne(query);

    if (!pickupAddress) {
      return res
        .status(404)
        .json({ message: "Pickup address not found or unauthorized." });
    }

    // Delete the address
    await pickAddress.deleteOne({ _id: id });

    res.status(200).json({ message: "Pickup address deleted successfully." });
  } catch (error) {
    console.error("Error deleting pickup address:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};

const getOrders = async (req, res) => {
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
      pickupContactName,
      courierServiceName
    } = req.query;
    let userId = null;
    // console.log("req", req.query)
    if (id && id !== "undefined" && id !== "null") {
      userId = id;
    } else if (req.user?._id) {
      userId = req.user._id;
    } else if (req.employee?._id) {
      userId = req.employee._id;
    }

    if (!userId) {
      return res.status(400).json({ error: "User ID required" });
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);



    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const andConditions = [{ userId: userObjectId }];


    // Include B2C + orders without orderType
    andConditions.push({
      $or: [{ orderType: "B2C" }, { orderType: { $exists: false } }],
    });

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
    if (awbNumber?.trim()) {
      andConditions.push({ awb_number: awbNumber.trim() });
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
    const filter = { $and: andConditions };
    if (pickupContactName && pickupContactName.length > 0) {
      const names = Array.isArray(pickupContactName)
        ? pickupContactName
        : pickupContactName.split(",");

      filter["pickupAddress.contactName"] = {
        $in: names.map((n) => n.trim()),
      };
    }



    const totalCount = await Order.countDocuments(filter);
    const statusCondition = andConditions.find((c) => c.status);
    const sortOption =
      statusCondition?.status?.$in?.includes("new") ||
        statusCondition?.status === "new"
        ? { createdAt: -1 }
        : { updatedAt: -1 };
    let query = Order.find(filter).sort(sortOption).allowDiskUse(true);
    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    // console.log(orders)
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    const allCourierServices = await Order.aggregate([
      {
        $match: { userId: userObjectId }
      },
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
    const allPickupLocations = await pickAddress.find({
      userId: userObjectId,
    })
      // .select("pickupAddress isPrimary")
      .lean();

    const formattedPickupLocations = allPickupLocations.map(p => ({
      ...p.pickupAddress,
      // isPrimary: p.isPrimary
    }));


    // console.log("all pickup", allPickupLocations)
    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: formattedPickupLocations,
      courierServices: allCourierServices.map((c) => c.courierServiceName),
    });
  } catch (error) {
    console.error("Error fetching paginated orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getShippingOrders = async (req, res) => {
  try {
    const {
      id,
      status,
      searchQuery,
      orderId,
      awbNumber,
      trackingId,
      paymentType,
      fromDate,
      toDate,
    } = req.query;
    // console.log("re",req.query)
    let userId;
    if (id) {
      userId = id;
    } else {
      userId = req.user?._id || req.employee?._id;
    }

    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;

    const andConditions = [{ userId }];

    // ✅ Exclude "New" and "Cancelled" orders
    andConditions.push({
      status: { $nin: ["new"] },
    });

    // If specific statuses are requested, combine with exclusion rule
    if (status && status !== "All") {
      const statusArray = Array.isArray(status)
        ? status
        : status.split(",").map((s) => s.trim());

      andConditions.push({
        status: { $in: statusArray, $nin: ["new", "Cancelled"] },
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

    if (req.query.courierServiceName) {
      const couriers = req.query.courierServiceName.split(",").map((c) => c.trim());
      andConditions.push({ courierServiceName: { $in: couriers } });
    }

    if (paymentType) {
      andConditions.push({ "paymentDetails.method": paymentType });
    }

    if (fromDate && toDate) {
      const start = new Date(fromDate);
      const end = new Date(toDate);
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

    let query = Order.find(filter).sort({ createdAt: -1 }).allowDiskUse(true);
    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
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

    const allPickupLocations = await Order.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: {
            contactName: "$pickupAddress.contactName",
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

    // Attach WeightDiscrepancy data for each order
    const awbNumbers = orders.map(o => o.awb_number).filter(Boolean);
    if (awbNumbers.length > 0) {
      const discrepancies = await WeightDiscrepancy.find(
        { awbNumber: { $in: awbNumbers } },
        { chargedWeight: 1, chargeDimension: 1, excessWeightCharges: 1, awbNumber: 1 }
      ).lean();
      const discMap = {};
      for (const d of discrepancies) discMap[d.awbNumber] = d;
      for (const o of orders) o.weightDiscrepancy = discMap[o.awb_number] || null;
    }

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: allPickupLocations,
      courierServices: allCourierServices.map((c) => c.courierServiceName),
    });
  } catch (error) {
    console.error("Error fetching active orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getOrdersByNdrStatus = async (req, res) => {
  try {
    const { pickupContactName } = req.query;
    const { id } = req.query;
    let userId;
    if (id) {
      userId = id;
    } else {
      userId = req.user._id;
    }
    console.log("req", req.query)
    const page = parseInt(req.query.page) || 1;
    const limitQuery = req.query.limit;
    const limit =
      limitQuery === "All" || !limitQuery ? null : parseInt(limitQuery);
    const skip = limit ? (page - 1) * limit : 0;
    const status = req.query.status;
    const tab = req.query.tab;
    const andConditions = [{ userId }];
    // ⭐ Special logic for Action Required tab
    if (status === "Undelivered" && tab === "Action_Required") {
      andConditions.push({ ndrStatus: "Undelivered" });
      andConditions.push({ reattempt: true });
    } else if (status === "Undelivered" && tab === "") {
      andConditions.push({ ndrStatus: status });
      andConditions.push({ reattempt: false });
    }

    if (status && status !== "All") {
      andConditions.push({ ndrStatus: status });
    }

    // Add filters like in getOrders
    if (req.query.searchQuery) {
      andConditions.push({
        $or: [
          {
            "receiverAddress.contactName": {
              $regex: req.query.searchQuery,
              $options: "i",
            },
          },
          {
            "receiverAddress.email": {
              $regex: req.query.searchQuery,
              $options: "i",
            },
          },
          {
            "receiverAddress.phoneNumber": {
              $regex: req.query.searchQuery,
              $options: "i",
            },
          },
        ],
      });
    }
    if (req.query.orderId) {
      const orderIdNum = parseInt(req.query.orderId);
      if (!isNaN(orderIdNum)) {
        andConditions.push({ orderId: orderIdNum });
      }
    }
    if (req.query.awbNumber) {
      andConditions.push({
        awb_number: { $regex: req.query.awbNumber, $options: "i" },
      });
    }
    if (req.query.trackingId) {
      andConditions.push({
        trackingId: { $regex: req.query.trackingId, $options: "i" },
      });
    }
    if (req.query.courierServiceName) {
      const couriers = Array.isArray(req.query.courierServiceName)
        ? req.query.courierServiceName
        : req.query.courierServiceName.split(",");

      andConditions.push({
        courierServiceName: {
          $in: couriers.map((c) => c.trim()),
        },
      });
    }

    if (req.query.paymentType) {
      andConditions.push({ "paymentDetails.method": req.query.paymentType });
    }
    if (req.query.startDate && req.query.endDate) {
      const start = new Date(req.query.startDate);
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      andConditions.push({ createdAt: { $gte: start, $lte: end } });
    }


    const filter = { $and: andConditions };

    if (pickupContactName) {
      const names = Array.isArray(pickupContactName)
        ? pickupContactName
        : pickupContactName.split(",");

      andConditions.push({
        "pickupAddress.contactName": {
          $in: names.map((n) => n.trim()),
        },
      });
    }


    const totalCount = await Order.countDocuments(filter);

    let query = Order.find(filter).sort({
      "ndrReason.date": -1,
      createdAt: -1,
    }).allowDiskUse(true);

    if (limit) query = query.skip(skip).limit(limit);

    const orders = await query.lean();
    const totalPages = limit ? Math.ceil(totalCount / limit) : 1;

    // Add these two aggregations:
    const allCourierServices = await Order.aggregate([
      { $match: { userId } },
      { $group: { _id: "$courierServiceName" } },
      { $project: { _id: 0, courierServiceName: "$_id" } },
    ]);
    // Fetch all unique pickup locations for the user (not filtered)
    const allPickupLocations = await pickAddress.find({
      userId,
    })
      // .select("pickupAddress isPrimary")
      .lean();

    const formattedPickupLocations = allPickupLocations.map(p => ({
      ...p.pickupAddress,
      // isPrimary: p.isPrimary
    }));

    res.json({
      orders,
      totalPages,
      totalCount,
      currentPage: page,
      pickupLocations: formattedPickupLocations,
      courierServices: allCourierServices.map((c) => c.courierServiceName),
    });
  } catch (error) {
    console.error("Error fetching paginated orders:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};const setPrimaryPickupAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user?.isAdmin === true && req.user?.adminTab === true;
    const isEmployee = req.isEmployee === true || !!req.employee;

    let query = { _id: id };
    if (!isAdmin && !isEmployee) {
      query.userId = req.user?._id;
    }

    // 1. Check if the pickup address exists and belongs to the user
    const pickupAddress = await pickAddress.findOne(query);
    if (!pickupAddress) {
      return res
        .status(404)
        .json({ message: "Pickup address not found or unauthorized." });
    }

    // 2. Set all other pickup addresses' isPrimary to false
    const ownerUserId = pickupAddress.userId;
    await pickAddress.updateMany({ userId: ownerUserId }, { $set: { isPrimary: false } });

    // 3. Set the selected address as primary
    pickupAddress.isPrimary = true;
    await pickupAddress.save();

    res.status(200).json({
      message: "Primary pickup address updated successfully.",
      pickupAddress,
    });
  } catch (error) {
    console.error("Error setting primary pickup address:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};

const updatePickupAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user?.isAdmin === true && req.user?.adminTab === true;
    const isEmployee = req.isEmployee === true || !!req.employee;

    let query = { _id: id };
    if (!isAdmin && !isEmployee) {
      query.userId = req.user?._id;
    }

    console.log("Updating pickup address ID:", id);

    const { contactName, email, phoneNumber, address, pinCode, city, state } =
      req.body;

    const pickupAddress = await pickAddress.findOne(query);

    if (!pickupAddress) {
      return res
        .status(404)
        .json({ message: "Pickup address not found or unauthorized." });
    }

    // Update fields
    pickupAddress.pickupAddress.contactName = contactName;
    pickupAddress.pickupAddress.email = email;
    pickupAddress.pickupAddress.phoneNumber = phoneNumber;
    pickupAddress.pickupAddress.address = address;
    pickupAddress.pickupAddress.pinCode = pinCode;
    pickupAddress.pickupAddress.city = city;
    pickupAddress.pickupAddress.state = state;

    await pickupAddress.save();

    res.status(200).json({
      message: "Pickup address updated successfully.",
      pickupAddress,
    });
  } catch (error) {
    console.error("Error updating pickup address:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};

const updateOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    // console.log("orderId", orderId);
    const {
      pickupAddress,
      receiverAddress,
      paymentDetails,
      packageDetails,
      otherDetails,
    } = req.body;

    console.log(req.body);
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ message: "Invalid orderId format." });
    }

    const existingOrder = await Order.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ message: "Order not found." });
    }
    //   if (!req.body.paymentDetails || !req.body.paymentDetails.amount) {
    //     return res.status(400).json({ error: "paymentDetails and amount are required" });
    // }
    // console.log(pickupAddress)

    const updateFields = {};

    // Update pickupAddress if provided
    if (pickupAddress) {
      updateFields.pickupAddress = {
        contactName: pickupAddress.contactName,
        phoneNumber: pickupAddress.phoneNumber,
        email: pickupAddress.email,
        address: pickupAddress.address,
        city: pickupAddress.city,
        state: pickupAddress.state,
        pinCode: pickupAddress.pinCode,
      };
      // Remove undefined fields to avoid overwriting with null
      Object.keys(updateFields.pickupAddress).forEach(key =>
        updateFields.pickupAddress[key] === undefined && delete updateFields.pickupAddress[key]
      );
    }

    // Update receiverAddress if provided
    if (receiverAddress) {
      updateFields.receiverAddress = {
        contactName: receiverAddress.contactName,
        phoneNumber: receiverAddress.phoneNumber,
        email: receiverAddress.email,
        address: receiverAddress.address,
        city: receiverAddress.city,
        state: receiverAddress.state,
        pinCode: receiverAddress.pinCode,
      };
      // Remove undefined fields to avoid overwriting with null
      Object.keys(updateFields.receiverAddress).forEach(key =>
        updateFields.receiverAddress[key] === undefined && delete updateFields.receiverAddress[key]
      );
    }

    // Ensure paymentDetails exist before updating
    if (paymentDetails) {
      updateFields.paymentDetails = {
        method: paymentDetails.method || existingOrder.paymentDetails?.method,
        amount: paymentDetails.amount || existingOrder.paymentDetails?.amount,
      };
    }

    // Ensure packageDetails exist before updating
    if (packageDetails) {
      updateFields.packageDetails = {
        deadWeight:
          packageDetails.deadWeight || existingOrder.packageDetails?.deadWeight,
        applicableWeight:
          packageDetails.applicableWeight ||
          existingOrder.packageDetails?.applicableWeight,
        volumetricWeight: {
          length:
            packageDetails.volumetricWeight?.length ||
            existingOrder.packageDetails?.volumetricWeight?.length,
          width:
            packageDetails.volumetricWeight?.width ||
            existingOrder.packageDetails?.volumetricWeight?.width,
          height:
            packageDetails.volumetricWeight?.height ||
            existingOrder.packageDetails?.volumetricWeight?.height,
        },
      };
    }

    // Ensure otherDetails exist before updating
    if (otherDetails) {
      updateFields.otherDetails = {
        gstin: otherDetails.gstin || existingOrder.otherDetails?.gstin,
      };
    }

    console.log("updateFields to be applied:", updateFields);

    // Update order in the database
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: updateFields },
      { new: true, runValidators: true },
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: "Order not found." });
    }

    res.status(200).json({
      message: "Order updated successfully.",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating order:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};

const updateProductDetails = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { productDetails } = req.body;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ message: "Invalid orderId format." });
    }

    if (!productDetails || !Array.isArray(productDetails)) {
      return res
        .status(400)
        .json({ message: "productDetails must be an array." });
    }

    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: { productDetails: productDetails } },
      { new: true, runValidators: true },
    );

    if (!updatedOrder) {
      return res.status(404).json({ message: "Order not found." });
    }

    res.status(200).json({
      message: "Product details updated successfully.",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating product details:", error);
    res.status(500).json({ message: "Internal server error." });
  }
};
const getOrdersById = async (req, res) => {
  const { id } = req.params;

  try {
    let order;

    // ✅ Case 1: If valid Mongo ObjectId → search by _id
    if (mongoose.Types.ObjectId.isValid(id)) {
      order = await Order.findById(id);
    }

    // ✅ Case 2: If not found OR not ObjectId → search by orderId
    if (!order) {
      order = await Order.findOne({ orderId: id });
    }

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    return res.status(200).json(order);

  } catch (err) {
    console.error("Error fetching order:", err);
    return res.status(500).json({ message: "Server error" });
  }
};


const updatedStatusOrders = async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid order ID format" });
    }

    // Find the order first
    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Check current status
    if (order.status !== "Cancelled") {
      return res.status(400).json({
        success: false,
        message:
          "Order is not ready to be cloned. Current status: " + order.status,
      });
    }

    // Generate a new unique order ID
    const newOrderId = await generateUniqueOrderIds(1);
    const compositeOrderId = `${order.userId}-${newOrderId}`;

    // Create a new shipment document (cloning relevant details)
    const newOrderDoc = new Order({
      userId: order.userId,
      orderId: newOrderId,
      pickupAddress: order.pickupAddress,
      receiverAddress: order.receiverAddress,
      productDetails: order.productDetails,
      packageDetails: order.packageDetails,
      paymentDetails: order.paymentDetails,
      otherDetails: order.otherDetails,
      compositeOrderId,
      status: "new",
      channel: order.channel || "custom",
      orderType: order.orderType || "B2C",
      B2BPackageDetails: order.B2BPackageDetails,
      rovType: order.rovType,
      commodityId: order.commodityId,
      tracking: [
        {
          status: "new",
          StatusLocation: order.pickupAddress?.city || "N/A",
          StatusDateTime: new Date(),
          Instructions: "Order created successfully",
        },
      ],
    });

    await newOrderDoc.save();

    res.status(200).json({
      success: true,
      message: "Order cloned successfully.",
      order: newOrderDoc,
    });
  } catch (error) {
    console.error("Error cloning order:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const bulkCloneOrders = async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "No order IDs provided" });
    }

    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));

    if (validIds.length === 0) {
      return res.status(400).json({ error: "No valid order IDs provided" });
    }

    // Find only orders that are currently "Cancelled"
    const originalOrders = await Order.find({
      _id: { $in: validIds },
      status: "Cancelled",
    });

    if (originalOrders.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No cancelled orders found to clone.",
      });
    }

    // Generate new unique order IDs
    const count = originalOrders.length;
    const generatedIds = await generateUniqueOrderIds(count);
    const newIdsArray = count === 1 ? [generatedIds] : generatedIds;

    const clonedOrders = [];
    for (let i = 0; i < originalOrders.length; i++) {
      const order = originalOrders[i];
      const newOrderId = newIdsArray[i];
      const compositeOrderId = `${order.userId}-${newOrderId}`;

      const newOrderDoc = new Order({
        userId: order.userId,
        orderId: newOrderId,
        pickupAddress: order.pickupAddress,
        receiverAddress: order.receiverAddress,
        productDetails: order.productDetails,
        packageDetails: order.packageDetails,
        paymentDetails: order.paymentDetails,
        otherDetails: order.otherDetails,
        compositeOrderId,
        status: "new",
        channel: order.channel || "custom",
        orderType: order.orderType || "B2C",
        B2BPackageDetails: order.B2BPackageDetails,
        rovType: order.rovType,
        commodityId: order.commodityId,
        tracking: [
          {
            status: "new",
            StatusLocation: order.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
            Instructions: "Order created successfully",
          },
        ],
      });

      clonedOrders.push(newOrderDoc);
    }

    // Save cloned orders in parallel to trigger save hooks
    await Promise.all(clonedOrders.map((doc) => doc.save()));

    res.status(200).json({
      success: true,
      message: `${clonedOrders.length} order(s) cloned successfully.`,
    });
  } catch (error) {
    console.error("Error bulk cloning orders:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const getpickupAddress = async (req, res) => {
  try {
    const isAdmin = req.user?.isAdmin === true && req.user?.adminTab === true;
    const isEmployee = req.isEmployee === true || !!req.employee;

    const { page = 1, limit = 20 } = req.query;

    let query = {};
    if (!isAdmin && !isEmployee) {
      query.userId = req.user?._id?.toString();
    } else {
      if (req.query.userId && req.query.userId !== "all" && req.query.userId !== "undefined" && req.query.userId !== "null" && req.query.userId.trim() !== "") {
        query.userId = req.query.userId.trim();
      }
    }

    if (!query.userId && !isAdmin && !isEmployee) {
      return res.status(400).json({
        success: false,
        message: "User ID is missing or invalid",
      });
    }

    const parsedPage = Math.max(1, parseInt(page));
    const parsedLimit = (isAdmin || isEmployee) ? Math.max(1, parseInt(limit)) : 1000;
    const skip = (parsedPage - 1) * parsedLimit;

    const total = await pickAddress.countDocuments(query);

    const pickupAddresses = await pickAddress.find(query)
      .populate("userId", "fullname company email userId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parsedLimit)
      .lean();

    res.status(200).json({ 
      success: true, 
      data: pickupAddresses || [],
      totalPages: Math.ceil(total / parsedLimit),
      total
    });
  } catch (error) {
    console.error("Error fetching pickup addresses:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const getreceiverAddress = async (req, res) => {
  try {
    const receiverAddresses = await receiveAddress.find({
      userId: req.user._id,
    });

    if (!receiverAddresses.length) {
      return res
        .status(404)
        .json({ success: false, message: "No receiver addresses found" });
    }

    res.status(200).json({ success: true, data: receiverAddresses });
  } catch (error) {
    console.error("Error fetching receiver addresses:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const searchReceiver = async (req, res) => {
  try {
    const { query, userId: id } = req.query;

    let userId =
      id && id !== "undefined" && id.trim() !== ""
        ? id
        : req.user?._id || req.employee?._id;

    // console.log("Search Receiver Request:", { query, id, userId });

    if (!query || query.length < 2) {
      return res.status(200).json({ success: true, receivers: [] });
    }

    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID required" });
    }

    // Validate ObjectId
    let userObjectId;
    try {
      userObjectId = new mongoose.Types.ObjectId(userId);
    } catch (e) {
      return res.status(400).json({ success: false, message: "Invalid User ID format" });
    }

    // ✅ Fetch User to check admin status
    const userData = await user.findById(userObjectId).select("isAdmin adminTab");

    if (!userData) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isAdmin =
      userData?.isAdmin === true && userData?.adminTab === true;

    // ✅ Build Match Condition Dynamically
    const matchStage = isAdmin
      ? {} // Admin → no user filter
      : { userId: userObjectId }; // Normal user → filter by userId

    const receivers = await Order.aggregate([
      { $match: matchStage },

      {
        $match: {
          $or: [
            { "receiverAddress.contactName": { $regex: query, $options: "i" } },
            { "receiverAddress.email": { $regex: query, $options: "i" } },
            { "receiverAddress.phoneNumber": { $regex: query, $options: "i" } },
          ],
        },
      },

      {
        $group: {
          _id: {
            contactName: "$receiverAddress.contactName",
            email: "$receiverAddress.email",
            phoneNumber: "$receiverAddress.phoneNumber",
          },
        },
      },

      {
        $project: {
          _id: 0,
          contactName: "$_id.contactName",
          email: "$_id.email",
          phoneNumber: "$_id.phoneNumber",
        },
      },

      { $limit: 10 },
    ]);

    res.status(200).json({ success: true, receivers });

  } catch (error) {
    console.error("Error searching receiver:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};


const ShipeNowOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const plan = await Plan.findOne({ userId: order.userId }).lean();
    if (!plan) {
      return res.status(404).json({ error: "No plan found for this user" });
    }

    const [EDDRates, EPDRates, services] = await Promise.all([
      EDDMap.find().lean(),
      EPDMap.find().lean(),
      CourierService.find({ status: "Enable" }).lean(),
    ]);
    const normalize = (str) => str?.toLowerCase().replace(/\s+/g, "").trim();
    const providers = await Courier.find({
      courierProvider: { $in: services.map((s) => s.provider) },
    }).lean();
    const providerMap = {};
    for (const p of providers) {
      providerMap[normalize(p.courierProvider)] = p;
    }
    const enabledServices = services.filter((srvc) => {
      const provider = providerMap[normalize(srvc.provider)];
      if (provider?.status !== "Enable" || srvc.status !== "Enable") return false;
      const planRateCard = plan.rateCard.filter(
        (card) => {
          const sameProvider = normalize(card.courierProviderName) === normalize(srvc.provider);
          const sameName = normalize(card.courierServiceName) === normalize(srvc.name);
          const isBoxdSpecial = normalize(srvc.provider) === "boxdlogistics";
          return sameProvider && (sameName || isBoxdSpecial) && card.status === "Active";
        }
      );
      return planRateCard && planRateCard.length > 0;
    });

    const serviceabilityCache = {};
    const availableServicesResults = await Promise.all(
      enabledServices.map(async (item) => {
        const provider = item.provider;
        // Optimization: Cache serviceability results per provider during this request
        // We cache the PROMISE to handle concurrent requests correctly in Promise.all
        if (!serviceabilityCache[provider]) {
          serviceabilityCache[provider] = checkServiceabilityAll(
            item,
            order._id,
            order.pickupAddress.pinCode,
          );
        }
        let result = await serviceabilityCache[provider];
        // console.log("result",result)
        if (result && result.success) {
          if (item.provider?.toLowerCase() === "boxdlogistics" && Array.isArray(result.courier_ids)) {
            // Determine which courierId this specific service name maps to
            const sName = item.name?.toLowerCase() || "";
            const requiredCid = (sName.includes("flat 0.5kg") || sName.includes("flat 0.5")) ? 47 : sName.includes("flat 2kg") ? 7 : sName.includes("surface") ? 4 : sName.includes("air") ? 6 : null;
            if (requiredCid !== null && result.courier_ids.includes(requiredCid)) {
              return [{ item, courierId: requiredCid, virtualName: normalize(item.name) }];
            }
            return [];
          }
          return [{ item }];
        }
        return [];
      }),
    );
    // console.log("available", availableServicesResults);

    const filteredServices = Array.from(
      new Map(
        availableServicesResults
          .flat()
          .map((s) => [
            // Use normalized service name so each rate card variant (0.5KG, 1KG) is a unique key
            `${s.item.provider}-${normalize(s.virtualName || s.item.name)}`,
            s,
          ])
      ).values()
    );
    // console.log("filterservice",filteredServices)
    // ✅ calculate zone
    const zone = await getZone(
      order.pickupAddress.pinCode,
      order.receiverAddress.pinCode,
    );

    const payload = {
      pickupPincode: order.pickupAddress.pinCode,
      deliveryPincode: order.receiverAddress.pinCode,
      length: order.packageDetails.volumetricWeight.length,
      breadth: order.packageDetails.volumetricWeight.width,
      height: order.packageDetails.volumetricWeight.height,
      weight: order.packageDetails.applicableWeight,
      cod: order.paymentDetails.method === "COD" ? "Yes" : "No",
      valueInINR: order.paymentDetails.amount,
      userID: order.userId,
      filteredServices,
      rateCardType: plan.planName,
    };

    let rates = await calculateRateForService(payload);
    // console.log("rate", rates);
    // console.log("filtere", filteredServices);

    // ✅ Build updatedRates only for serviceable couriers
    const updatedRates = filteredServices
      .map((service) => {
        const matchedRate = rates.find((rate) => {
          const rateName = normalize(rate.courierServiceName);
          const serviceName = normalize(
            service.virtualName || service.item.name
          );
          // Exact match for all couriers including BoxdLogistics variants
          return rateName === serviceName;
        });

        if (!matchedRate) return null;

        const matchedEDD = EDDRates.find(
          (edd) => normalize(edd.serviceName) === normalize(service.item.name),
        );

        let estimatedDeliveryDate = null;
        if (matchedEDD && matchedEDD.zoneRates) {
          const zoneKey = zone.zone;
          const days = matchedEDD.zoneRates[zoneKey];
          if (days) {
            const eddDate = new Date();
            eddDate.setDate(eddDate.getDate() + days);
            estimatedDeliveryDate = eddDate;
          }
        }

        // ✅ Calculate Pickup Date based on Cutoff Time (EPDMap)

        const matchedEPD = EPDRates.find(
          (epd) => normalize(epd.serviceName) === normalize(service.item.name)
        );

        let pickupDate = null;
        if (matchedEPD && matchedEPD.cutoffTime) {
          pickupDate = new Date();
          const [cutoffHour, cutoffMinute] = matchedEPD.cutoffTime.split(":").map(Number);
          const now = new Date();
          const cutoff = new Date();
          cutoff.setHours(cutoffHour, cutoffMinute, 0, 0);

          if (now > cutoff) {
            pickupDate.setDate(now.getDate() + 1);
          }
        }
        // console.log("matchedRate",matchedRate)
        return {
          ...matchedRate,
          provider: service.item.provider,
          courierType: service.item.courierType,
          courier: service.courierId || service.item?.courier,
          serviceName: service.virtualName || service.item.name,
          estimatedDeliveryDate,
          pickupDate,
        };
      })
      .filter(Boolean);
    // console.log("update", updatedRates);
    // ✅ SORTING based on plan.priorityType
    let sortedRates = [...updatedRates];

    let priorityType = plan?.priorityType?.toLowerCase();
    if (!["cheapest", "fastest", "custom"].includes(priorityType)) {
      priorityType = "cheapest";
    }
    if (priorityType === "cheapest") {
      // Sort by lowest finalCharges
      sortedRates.sort((a, b) => {
        const chargeA = parseFloat(
          a.forward?.finalCharges || a.forward?.charges || 0,
        );
        const chargeB = parseFloat(
          b.forward?.finalCharges || b.forward?.charges || 0,
        );
        return chargeA - chargeB;
      });
    } else if (priorityType === "fastest") {
      sortedRates.sort(
        (a, b) =>
          new Date(a.estimatedDeliveryDate) - new Date(b.estimatedDeliveryDate),
      );
    } else if (priorityType === "custom" && Array.isArray(plan.rateCard)) {
      const customOrder = plan.rateCard.map((r) =>
        r?.courierServiceName?.toLowerCase(),
      );
      sortedRates.sort((a, b) => {
        const indexA = customOrder.indexOf(a.courierServiceName?.toLowerCase());
        const indexB = customOrder.indexOf(b.courierServiceName?.toLowerCase());
        return indexA - indexB;
      });
    }

    // console.log("sortedRates", sortedRates);

    res.status(201).json({
      success: true,
      order,
      updatedRates: sortedRates,
    });
  } catch (error) {
    console.error("Error in ShipeNowOrder:", error);
    res.status(500).json({ error: "Server error" });
  }
};

const pincodeData = [];
fs.createReadStream(path.join(__dirname, "../data/pincodes.csv"))
  .pipe(csv({ separator: "\t" })) // <-- Important fix
  .on("data", (row) => {
    if (row.pincode && row.city && row.state) {
      pincodeData.push({
        pincode: row.pincode.trim(),
        city: row.city.trim(),
        state: row.state.trim(),
      });
    } else {
      console.log("Invalid CSV row:", row);
    }
  })
  .on("end", () => {
    console.log("✅ CSV file successfully loaded. Total:", pincodeData.length);
  })
  .on("error", (err) => {
    console.error("❌ Error reading CSV file:", err);
  });

// ✅ API Controller
const getPinCodeDetails = async (req, res) => {
  try {
    const { pincode } = req.params;
    const foundEntry = pincodeData.find(
      (entry) => entry.pincode === pincode.trim(),
    );

    if (foundEntry) {
      res.json({
        city: foundEntry.city,
        state: foundEntry.state,
      });
    } else {
      res.status(404).json({ error: "Pincode not found" });
    }
  } catch (error) {
    console.error("❌ Error fetching pincode:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const cancelOrdersAtNotShipped = async (req, res) => {
  const { orderId } = req.body;
  // console.log(orderData)
  try {
    const currentOrder = await Order.findByIdAndDelete(orderId);

    if (!currentOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.status(200).json({ message: "Order deleted successfully" });
  } catch (error) {
    console.error("Error canceling orders:", {
      // error,
      // orders: ordersToBeCancelled.map((order) => order._id),
    });
    res
      .status(500)
      .send({ error: "An error occurred while cancelling orders." });
  }
};
const cancelOrdersAtBooked = async (req, res) => {
  const allOrders = req.body;
  // console.log(allOrders);
  try {
    const userId = allOrders.userId?._id || allOrders.userId;
    const users = await user.findOne({ _id: userId });
    // console.log(users)
    const currentWallet = await Wallet.findById(users.Wallet).select("_id");

    const currentOrder = await Order.findById({ _id: allOrders._id });
    if (currentOrder.awb_number === "N/A" || !currentOrder.awb_number) {
      return res
        .status(400)
        .send({ error: "Order cannot be cancelled missing awb_number" });
    }
    if (currentOrder.status === "Cancelled") {
      return res.status(400).send({ error: "Order is already Cancelled" });
    }
    const cancellableStatuses = ["Ready To Ship", "Booked", "Not Picked"];

    if (!cancellableStatuses.includes(currentOrder.status)) {
      return res.status(400).send({ error: "Order is not ready to Cancelled" });
    }

    if (currentOrder.provider === "Xpressbees") {
      const result = await cancelShipmentXpressBees(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: "Failed to cancel order" });
      }
    } else if (currentOrder.provider === "Shiprocket" || currentOrder.partner === "Shiprocket") {
      const result = await cancelShiprocketOrder(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).json({
          error: result.error || "Failed to cancel shipment with Shiprocket",
          details: result,
          orderId: currentOrder._id,
        });
      }
    } else if (currentOrder.provider === "Nimuspost") {
      const result = await cancelShipmentXpressBees(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: "Failed to cancel order" });
      }
    } else if (currentOrder.provider === "Delhivery") {
      // console.log("I am in it");
      const result = await cancelOrderDelhivery(currentOrder.awb_number);

      if (result.error) {
        return res.status(400).json({
          error: result?.error || "Failed to cancel shipment with Delhivery",
          details: result,
          orderId: currentOrder._id,
        });
      }
    } else if (currentOrder.provider === "Shree Maruti") {
      const result = await cancelOrderShreeMaruti(currentOrder.orderId);
      // console.log("shreemaruti",result)
      if (result.error) {
        // console.log("shree",result)
        return res.status(400).json({
          error: "Failed to cancel shipment with ShreeMaruti",
          details: result,
          orderId: currentOrder._id,
        });
      }
    } else if (currentOrder.provider === "Dtdc") {
      const result = await cancelOrderDTDC(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "EcomExpress") {
      const result = await cancelShipmentforward(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Amazon Shipping") {
      const result = await cancelShipment(currentOrder.shipment_id);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Smartship") {
      const result = await cancelSmartshipOrder(currentOrder.orderId);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Vamaship") {
      const result = await cancelVamashipOrder(currentOrder.shipment_id);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.partner === "ZipyPost") {
      const result = await cancelOrderZipypost(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Ekart") {
      const result = await cancelShipmentEkart(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.partner === "BoxdLogistics") {
      const result = await cancelOrderBoxdLogistics(currentOrder.awb_number, currentOrder.orderId);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.partner === "Proship") {
      const result = await cancelProshipOrder(currentOrder.awb_number);
      if (result.error) {
        return res.status(400).send({ error: result.error });
      }
    } else if (currentOrder.provider === "Shadowfax" || currentOrder.partner === "Shadowfax") {
      const result = await cancelShadowfaxOrder(currentOrder.awb_number, currentOrder.courierName);
      if (result.success === false) {
        return res.status(400).send({ error: result.message || "Failed to cancel order with Shadowfax" });
      }
    } else {
      return res.status(400).json({
        error: "Unsupported courier provider",
        orderId: currentOrder._id,
      });
    }

    // Remove from pickup manifest if exists
    try {
      await removeFromPickupManifest(currentOrder);
    } catch (err) {
      console.error("[Pickup] Failed to remove order from manifest during cancellation:", err.message);
    }

    // currentOrder.status = "Not-Shipped";
    // currentOrder.cancelledAtStage = "Booked";
    currentOrder.status = "Cancelled";
    currentOrder.tracking.push({
      status: "Cancelled",
      StatusLocation: "",
      StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
      Instructions: "Order cancelled successfully",
    });

    let balanceTobeAdded =
      currentOrder.totalFreightCharges == "N/A"
        ? 0
        : parseFloat(currentOrder.totalFreightCharges);
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // ✅ Guard: Check if this AWB was already refunded (credit exists)
      const alreadyRefunded = await WalletTransaction.exists({
        walletId: currentWallet._id,
        awb_number: currentOrder.awb_number,
        category: "credit",
        description: "Freight Charges Received",
      });

      if (balanceTobeAdded > 0 && !alreadyRefunded) {
        const updatedWallet = await Wallet.findOneAndUpdate(
          { _id: currentWallet._id },
          { $inc: { balance: balanceTobeAdded } },
          { new: true, session },
        );

        await WalletTransaction.create(
          [{
            walletId: updatedWallet._id,
            channelOrderId: currentOrder.orderId || null,
            category: "credit",
            amount: balanceTobeAdded,
            balanceAfterTransaction: updatedWallet.balance,
            date: new Date(),
            awb_number: currentOrder.awb_number || "",
            description: `Freight Charges Received`,
          }],
          { session }
        );
      } else if (balanceTobeAdded > 0 && alreadyRefunded) {
        console.log(`[Cancel] Skipping wallet refund for AWB ${currentOrder.awb_number} — already refunded.`);
      }

      await currentOrder.save({ session });
      await session.commitTransaction();
      session.endSession();
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }

    // console.log("hii")
    res.status(201).send({
      success: true,
    });
  } catch (error) {
    console.error("Error cancelling orders:", error);
    res
      .status(500)
      .send({ error: "An error occurred while cancelling orders." });
  }
};

// setInterval(trackOrders, 60 * 100000);
const passbook = async (req, res) => {
  try {
    const { id } = req.query;
    const userId = id || req.user._id;

    const {
      fromDate,
      toDate,
      category,
      description,
      awbNumber,
      orderId,
      page = 1,
      limit = 20,
    } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const currentUser = await user.findById(userId).select("_id Wallet").lean();
    if (!currentUser || !currentUser.Wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * parsedLimit;

    const filterConditions = { walletId: new mongoose.Types.ObjectId(currentUser.Wallet) };
    if (fromDate && toDate) {
      filterConditions.date = {
        $gte: new Date(fromDate),
        $lte: new Date(toDate),
      };
    }
    if (category) filterConditions.category = category;
    if (description) filterConditions.description = description;
    if (awbNumber) filterConditions.awb_number = awbNumber;
    if (orderId) filterConditions.channelOrderId = orderId;

    const [totalCount, walletTransactions] = await Promise.all([
      WalletTransaction.countDocuments(filterConditions),
      WalletTransaction.find(filterConditions)
        .sort({ date: -1 })
        .skip(parsedLimit > 0 ? skip : 0)
        .limit(parsedLimit > 0 ? parsedLimit : 0)
        .lean(),
    ]);

    const totalPages = parsedLimit === 0 ? 1 : Math.ceil(totalCount / parsedLimit);

    const awbsToLookup = [...new Set(walletTransactions.map((t) => t.awb_number).filter(Boolean))];
    const orderInfoMap = {};
    if (awbsToLookup.length > 0) {
      const orders = await Order.find(
        { awb_number: { $in: awbsToLookup } },
        { awb_number: 1, courierServiceName: 1, priceBreakup: 1, rateBreakup: 1, orderType: 1 }
      ).lean();
      for (const o of orders) {
        orderInfoMap[String(o.awb_number)] = o;
      }
    }

    const results = walletTransactions.map((t) => {
      const info = orderInfoMap[String(t.awb_number)] || {};
      return {
        _id: String(t._id),
        id: String(t._id),
        category: t.category,
        amount: t.amount,
        balanceAfterTransaction: t.balanceAfterTransaction,
        date: t.date,
        awb_number: t.awb_number,
        orderId: t.channelOrderId,
        description: t.description,
        courierServiceName: info.courierServiceName || null,
        priceBreakup: t.priceBreakup || info.priceBreakup || null,
        rateBreakup: info.rateBreakup || null,
        orderType: info.orderType || null,
      };
    });

    return res.status(200).json({
      message: "Passbook fetched successfully",
      results,
      totalCount,
      page: totalPages,
      currentPage: Number(page),
      limit: parsedLimit === 0 ? "All" : parsedLimit,
    });
  } catch (error) {
    console.error("Error fetching passbook:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};


const getUser = async (req, res) => {
  try {
    const userId = req.user._id;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }
    const users = await user.findOne({ _id: userId });
    if (!users) {
      return res.status(400).json({ message: "User Not found" });
    }
    return res.status(200).json(users);
  } catch (error) {
    return res.status(400).json({ message: "User not found" });
  }
};
const deleteOrder = async (req, res) => {
  try {
    const orderId = req.params.id || req.body.orderId;

    // Validate orderId
    if (!orderId) {
      return res
        .status(400)
        .json({ success: false, message: "Order ID is required." });
    }

    // Find and delete the order
    const deletedOrder = await Order.findByIdAndDelete(orderId);

    if (!deletedOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found." });
    }

    res
      .status(200)
      .json({ success: true, message: "Order deleted successfully." });
  } catch (error) {
    console.error("Error deleting order:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const GetTrackingByAwb = async (req, res) => {
  // console.log("hiei")
  try {
    const { awb } = req.params;
    // console.log("hii")
    const order = await Order.findOne({ awb_number: awb });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // console.log("Order details:", order);
    res.status(200).json(order);
  } catch (error) {
    console.error("Error fetching tracking details:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const GetTrackingByAwbs = async (req, res) => {
  try {
    const { awbs } = req.body; // Expect array of AWB numbers
    // console.log("body", awbs);
    if (!Array.isArray(awbs) || awbs.length === 0) {
      return res
        .status(400)
        .json({ message: "Please provide an array of AWB numbers" });
    }

    // Fetch all matching orders for the array of AWB numbers
    const orders = await Order.find({ awb_number: { $in: awbs } });

    // Return only found orders, skipping missing AWBs
    res.status(200).json(orders);
  } catch (error) {
    console.error("Error fetching tracking details:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const bulkCancelOrder = async (req, res) => {
  try {
    const { selectedOrders } = req.body;

    if (!Array.isArray(selectedOrders) || selectedOrders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No orders selected for cancellation.",
      });
    }

    // Fetch all orders
    const orders = await Order.find({ _id: { $in: selectedOrders } });
    if (!orders.length) {
      return res.status(404).json({ success: false, message: "No matching orders found." });
    }

    // Filter out orders that are not in cancellable statuses immediately
    const eligibleOrders = orders.filter(o =>
      ["Booked", "Not Picked", "Ready To Ship"].includes(o.status)
    );

    const skippedOrders = orders.filter(o =>
      !["Booked", "Not Picked", "Ready To Ship"].includes(o.status)
    );

    // 1. Immediately return success response to user
    res.status(200).json({
      success: true,
      message: `Bulk cancellation initiated in background for ${eligibleOrders.length} order(s).`,
      summary: {
        totalSelected: orders.length,
        initiatedCount: eligibleOrders.length,
        skippedCount: skippedOrders.length,
      }
    });

    // 2. Process cancellations in the background sequentially
    (async () => {
      const userCache = {};
      const walletCache = {};

      for (const currentOrder of eligibleOrders) {
        try {
          const provider = currentOrder.provider;
          const partner = currentOrder.partner;

          // Call provider cancel API
          let cancelResponse;
          try {
            if (provider === "Xpressbees") {
              cancelResponse = await cancelShipmentXpressBees(currentOrder.awb_number);
            } else if (provider === "Shiprocket" || partner === "Shiprocket") {
              cancelResponse = await cancelShiprocketOrder(currentOrder.awb_number);
            } else if (provider === "Nimuspost") {
              cancelResponse = await cancelShipmentXpressBees(currentOrder.awb_number);
            } else if (provider === "Delhivery") {
              cancelResponse = await cancelOrderDelhivery(currentOrder.awb_number);
            } else if (provider === "Shree Maruti") {
              cancelResponse = await cancelOrderShreeMaruti(currentOrder.orderId);
            } else if (provider === "Dtdc") {
              cancelResponse = await cancelOrderDTDC(currentOrder.awb_number);
            } else if (provider === "EcomExpress") {
              cancelResponse = await cancelShipmentforward(currentOrder.awb_number);
            } else if (provider === "Amazon Shipping") {
              cancelResponse = await cancelShipment(currentOrder.shipment_id);
            } else if (partner === "Smartship") {
              cancelResponse = await cancelSmartshipOrder(currentOrder.orderId);
            } else if (partner === "Vamaship") {
              cancelResponse = await cancelVamashipOrder(currentOrder.shipment_id);
            } else if (partner === "ZipyPost") {
              cancelResponse = await cancelOrderZipypost(currentOrder.awb_number);
            } else if (provider === "Ekart") {
              cancelResponse = await cancelShipmentEkart(currentOrder.awb_number);
            } else if (partner === "BoxdLogistics") {
              cancelResponse = await cancelOrderBoxdLogistics(currentOrder.awb_number, currentOrder.orderId);
            } else if (partner === "Proship") {
              cancelResponse = await cancelProshipOrder(currentOrder.awb_number);
            } else if (provider === "Shadowfax" || partner === "Shadowfax") {
              cancelResponse = await cancelShadowfaxOrder(currentOrder.awb_number, currentOrder.courierName);
            } else {
              cancelResponse = { success: false, error: `Unsupported courier provider: ${provider}` };
            }
          } catch (err) {
            cancelResponse = { success: false, error: err.message };
          }

          // Handle already cancelled states gracefully
          const errorMsg = (cancelResponse?.message || cancelResponse?.error || "").toLowerCase();
          const isAlreadyCancelled =
            errorMsg.includes("already cancelled") ||
            errorMsg.includes("already_cancelled") ||
            errorMsg.includes("cancellation not allowed") ||
            errorMsg.includes("shipment not found");

          const hasError = !!cancelResponse?.error || cancelResponse?.success === false || cancelResponse?.success === "false";
          const isSuccess = !hasError || isAlreadyCancelled;

          if (!isSuccess) {
            console.warn(`[Background BulkCancel] Failed AWB ${currentOrder.awb_number}: ${errorMsg}`);
            continue;
          }

          // Process DB updates and refund sequentially
          const userId = currentOrder.userId;
          let userDoc = userCache[userId];
          if (!userDoc) {
            userDoc = await user.findById(userId);
            if (userDoc) userCache[userId] = userDoc;
          }
          if (!userDoc) continue;

          const walletId = userDoc.Wallet;
          if (!walletId) continue;

          let walletDoc = walletCache[walletId];
          if (!walletDoc) {
            walletDoc = await Wallet.findById(walletId).select("balance");
            if (walletDoc) walletCache[walletId] = walletDoc;
          }
          if (!walletDoc) continue;

          // Remove from pickup manifest if exists
          try {
            await removeFromPickupManifest(currentOrder);
          } catch (err) {
            console.error("[Pickup] Failed to remove order from manifest during bulk cancellation:", err.message);
          }

          // Refund wallet balance safely
          const balanceToAdd =
            currentOrder.totalFreightCharges === "N/A"
              ? 0
              : parseFloat(currentOrder.totalFreightCharges) || 0;

          if (balanceToAdd > 0) {
            // Guard: Check if this AWB was already refunded
            const alreadyRefunded = await WalletTransaction.exists({
              walletId: walletId,
              awb_number: currentOrder.awb_number,
              category: "credit",
              description: "Freight Charges Received",
            });

            if (!alreadyRefunded) {
              const updatedWallet = await Wallet.findOneAndUpdate(
                { _id: walletId },
                { $inc: { balance: balanceToAdd } },
                { new: true },
              );

              // Update cached balance
              walletDoc.balance = updatedWallet.balance;

              await WalletTransaction.create([{
                walletId: walletId,
                channelOrderId: currentOrder.orderId || null,
                category: "credit",
                amount: balanceToAdd,
                balanceAfterTransaction: updatedWallet.balance,
                date: new Date(),
                awb_number: currentOrder.awb_number || "",
                description: "Freight Charges Received",
              }]);
            }
          }

          // Update order status to Cancelled
          currentOrder.status = "Cancelled";
          currentOrder.tracking.push({
            status: "Cancelled",
            StatusLocation: "",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
            Instructions: isAlreadyCancelled
              ? "Order cancelled successfully (Courier already cancelled)"
              : "Order cancelled successfully",
          });
          await currentOrder.save();

          console.log(`[Background BulkCancel] Successfully cancelled AWB ${currentOrder.awb_number}`);

        } catch (itemError) {
          console.error(`[Background BulkCancel] Error processing AWB ${currentOrder.awb_number}:`, itemError);
        }
      }
    })();

  } catch (error) {
    console.error("Bulk Cancel Error:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Internal server error during bulk cancellation.",
      });
    }
  }
};

const checkBulkPickup = async (req, res) => {
  try {
    const { orderIds } = req.query; // array of order IDs

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No order IDs provided" });
    }

    // Fetch orders with their pickupAddress
    const orders = await Order.find({ _id: { $in: orderIds } }).select(
      "pickupAddress userId",
    );

    if (orders.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Orders not found" });
    }

    // Only 1 order selected → popup required
    if (orders.length === 1) {
      return res.json({
        success: true,
        showPopup: true,
        orders,
      });
    }

    // Check if all pickup addresses are the same
    const pickupAddresses = orders.map((o) =>
      JSON.stringify(o.pickupAddress || {}),
    );
    const allSame =
      pickupAddresses.every((addr) => addr === pickupAddresses[0]) &&
      pickupAddresses[0] !== "{}";

    res.json({
      success: true,
      showPopup: !allSame, // true if addresses differ → show popup
      allSame,
      orders,
      defaultPickup: allSame ? orders[0].pickupAddress : null,
    });
  } catch (error) {
    console.error("Error in checkBulkPickup:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const checkBulkUser = async (req, res) => {
  try {
    const { orderIds } = req.query;

    // ✅ Check if orderId param is valid
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing order IDs",
      });
    }

    // ✅ Fetch all orders by IDs
    const orders = await Order.find({ _id: { $in: orderIds } }).select(
      "userId",
    );

    if (!orders || orders.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No orders found for given IDs",
      });
    }

    // ✅ Extract all unique userIds
    const uniqueUsers = [...new Set(orders.map((o) => o.userId.toString()))];

    if (uniqueUsers.length === 1) {
      // ✅ All belong to same user
      return res.status(200).json({
        success: true,
        userId: uniqueUsers[0],
      });
    } else {
      // ❌ Different users found
      return res.status(400).json({
        success: false,
        message: "Selected orders belong to multiple users",
      });
    }
  } catch (error) {
    console.error("Error checking bulk user:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while checking orders",
      error: error.message,
    });
  }
};

const checkCourier = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
};

// Master Search Controller - Search across multiple fields
const masterSearch = async (req, res) => {
  try {
    const { query } = req.query;

    const userId = req.user?._id || req.employee?._id;

    if (!query || query.trim().length < 2) {
      return res.json({ orders: [] });
    }

    // ✅ Fetch user properly
    const userData = await user.findById(userId).select("isAdmin adminTab");

    const isAdmin =
      userData?.isAdmin === true && userData?.adminTab === true;

    const searchTerm = query.trim();

    const searchConditions = [];

    // If numeric → match orderId
    if (!isNaN(searchTerm)) {
      searchConditions.push({ orderId: parseInt(searchTerm) });
    }

    // Text search
    searchConditions.push(
      { awb_number: { $regex: searchTerm, $options: "i" } },
      { "pickupAddress.contactName": { $regex: searchTerm, $options: "i" } },
      { "pickupAddress.email": { $regex: searchTerm, $options: "i" } },
      { "pickupAddress.phoneNumber": { $regex: searchTerm, $options: "i" } },
      { "receiverAddress.contactName": { $regex: searchTerm, $options: "i" } },
      { "receiverAddress.email": { $regex: searchTerm, $options: "i" } },
      { "receiverAddress.phoneNumber": { $regex: searchTerm, $options: "i" } },
      { courierServiceName: { $regex: searchTerm, $options: "i" } },
      { provider: { $regex: searchTerm, $options: "i" } }
    );

    // ✅ Build filter dynamically
    let filter;

    if (isAdmin) {
      // Admin → no userId restriction
      filter = { $or: searchConditions };
    } else {
      // Normal user → restrict by userId
      filter = {
        $and: [
          { userId },
          { $or: searchConditions }
        ]
      };
    }

    const orders = await Order.find(filter)
      .select("orderId awb_number status courierServiceName provider paymentDetails createdAt")
      .sort({ updatedAt: -1 })
      .limit(10)
      .allowDiskUse(true)
      .lean();

    res.json({ orders });

  } catch (error) {
    console.error("Master search error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const downloadPickupAddressesExcel = async (req, res) => {
  try {
    const query = {};
    
    // Check if the requesting user is an Admin or an Employee
    const isAdmin = req.user?.isAdmin === true && req.user?.adminTab === true;
    const isEmployee = req.isEmployee === true || !!req.employee;

    // If NOT an admin/employee, force filtering by their own userId
    if (!isAdmin && !isEmployee) {
      const userId = req.user?._id?.toString();
      if (!userId) {
        return res.status(400).json({
          success: false,
          message: "User ID is missing or invalid",
        });
      }
      query.userId = userId;
    } else if (req.query.userId && req.query.userId !== "all") {
      query.userId = req.query.userId;
    }

    const pickupAddresses = await pickAddress.find(query)
      .populate("userId", "fullname company email userId")
      .lean();

    if (!pickupAddresses.length) {
      return res.status(404).json({ message: "No pickup addresses found" });
    }

    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Pickup Addresses");

    worksheet.columns = [
      { header: "id", key: "id", width: 30 },
      { header: "Contact Name", key: "contactName", width: 25 },
      { header: "Email Address", key: "email", width: 25 },
      { header: "Phone Number", key: "phoneNumber", width: 15 },
      { header: "Address", key: "address", width: 40 },
      { header: "Pincode", key: "pinCode", width: 15 },
      { header: "City", key: "city", width: 20 },
      { header: "State", key: "state", width: 20 },
    ];

    pickupAddresses.forEach((item) => {
      const details = item.pickupAddress || {};
      worksheet.addRow({
        id: item._id ? item._id.toString() : "N/A",
        contactName: details.contactName || "N/A",
        email: details.email || "N/A",
        phoneNumber: details.phoneNumber || "N/A",
        address: details.address || "N/A",
        pinCode: details.pinCode || "N/A",
        city: details.city || "N/A",
        state: details.state || "N/A",
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=pickup-addresses.xlsx"
    );

    await workbook.xlsx.write(res);
    res.status(200).end();
  } catch (error) {
    console.error("Error exporting pickup addresses:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};


module.exports = {
  newOrder,
  getOrders,
  getOrdersByNdrStatus,
  updatedStatusOrders,
  bulkCloneOrders,
  getOrdersById,
  getpickupAddress,
  downloadPickupAddressesExcel,
  getreceiverAddress,
  searchReceiver,
  newPickupAddress,
  newReciveAddress,
  ShipeNowOrder,
  getPinCodeDetails,
  cancelOrdersAtNotShipped,
  cancelOrdersAtBooked,
  // tracking,
  updateOrder,
  updateProductDetails,
  passbook,
  getUser,
  updatePackageDetails,
  GetTrackingByAwb,
  GetTrackingByAwbs,
  updatePickupAddress,
  setPrimaryPickupAddress,
  deletePickupAddress,
  getShippingOrders,
  bulkCancelOrder,
  checkBulkPickup,
  checkBulkUser,
  checkCourier,
  masterSearch,
};
