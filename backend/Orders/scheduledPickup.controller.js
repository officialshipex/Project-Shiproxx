const mongoose = require("mongoose");
const Order = require("../models/newOrder.model");
const PickupManifest = require("../models/pickupManifest.model");
const PickupManifestCounter = require("../models/pickupManifestCounter.model");
const AllocateRole = require("../models/allocateRoleSchema");
const User = require("../models/User.model");

/* ================================================================
   CORE UTILITY — called automatically after any shipment is created
   Groups by: date + pickupAddress + provider (courier service)
   ================================================================ */
const assignPickupManifest = async (order) => {
  try {
    // ── Dynamic Cutoff Logic (IST) ────────────────────────────────────────────
    const EPDMap = require("../models/EPDMap.model");
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    const currentISTHour = istTime.getUTCHours();
    const currentISTMinute = istTime.getUTCMinutes();

    // Fetch EPD mapping for this courier service
    const epdMapping = await EPDMap.findOne({
      courier: order.partner || order.provider,
      serviceName: order.courierServiceName,
    });

    let cutoffHour = 10;
    let cutoffMinute = 0;

    if (epdMapping && epdMapping.cutoffTime) {
      const [h, m] = epdMapping.cutoffTime.split(":").map(Number);
      cutoffHour = h;
      cutoffMinute = m;
    }

    let targetDate = new Date(now.getTime() + istOffset);
    
    // Check if current time is past cutoff
    if (currentISTHour > cutoffHour || (currentISTHour === cutoffHour && currentISTMinute >= cutoffMinute)) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    // Set to IST midnight (represented as UTC timestamp for DB consistency)
    targetDate.setUTCHours(0, 0, 0, 0);

    // ── Grouping filters ────────────────────────────────────────────────────
    const manifestFilter = {
      userId: order.userId,
      pickupDate: targetDate,
      provider: order.provider,
      orderType: order.orderType || "B2C",
      "pickupAddress.address": order.pickupAddress?.address,
      "pickupAddress.contactName": order.pickupAddress?.contactName,
      "pickupAddress.pinCode": order.pickupAddress?.pinCode,
    };

    let manifest = await PickupManifest.findOne(manifestFilter);

    if (!manifest) {
      // ── Create new manifest ───────────────────────────────────────────────
      const pickupId = await generatePickupId(order.orderType === "B2B");

      manifest = await PickupManifest.create({
        ...manifestFilter,
        pickupId,
        status: "Pickup_Scheduled",
        orderIds: [order._id],
        awb_numbers: order.awb_number ? [order.awb_number] : [],
        courierServiceNames: order.courierServiceName ? [order.courierServiceName] : [],
        pickupAddress: order.pickupAddress,
      });

      console.log(`[Pickup] Internal: Created manifest ${pickupId} for order ${order._id}`);
    } else {
      // ── Append to existing manifest ───────────────────────────────────────
      await PickupManifest.updateOne(
        { _id: manifest._id },
        {
          $addToSet: {
            orderIds: order._id,
            awb_numbers: order.awb_number,
            courierServiceNames: order.courierServiceName,
          },
          $set: { status: "Pickup_Scheduled" }
        }
      );
      console.log(`[Pickup] Internal: Appended order ${order._id} to existing manifest ${manifest.pickupId}`);
    }

    // Save manifest details back to the order
    await Order.findByIdAndUpdate(order._id, { 
      pickupId: manifest.pickupId,
      pickupDate: targetDate
    });

    return manifest.pickupId;
  } catch (err) {
    console.error("[Pickup] assignPickupManifest error:", err.message);
    return null;
  }
};

const removeFromPickupManifest = async (order) => {
  try {
    if (!order.pickupId) return;

    const manifest = await PickupManifest.findOne({ pickupId: order.pickupId });
    if (!manifest) return;

    // Remove order and awb from manifest
    await PickupManifest.updateOne(
      { _id: manifest._id },
      {
        $pull: {
          orderIds: order._id,
          awb_numbers: order.awb_number
        }
      }
    );

    // Re-fetch to check if it's empty
    const updatedManifest = await PickupManifest.findById(manifest._id);
    if (updatedManifest && updatedManifest.orderIds.length === 0) {
      await PickupManifest.deleteOne({ _id: manifest._id });
      console.log(`[Pickup] Deleted empty manifest: ${order.pickupId}`);
    } else {
      console.log(`[Pickup] Removed order ${order._id} from manifest: ${order.pickupId}`);
    }
  } catch (err) {
    console.error("[Pickup] removeFromPickupManifest error:", err.message);
  }
};

/* ================================================================
   HTTP CONTROLLER — kept for manual scheduling from admin panel
   ================================================================ */
// schedulePickup removed as requested — logic is now fully automatic via assignPickupManifest


const getPickupManifests = async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate, searchQuery, pickupContactName, courierServiceName, orderType } = req.query;

    const userId = req.user?._id;

    let query = {};
    if (userId) query.userId = userId;

    if (startDate || endDate) {
      query.pickupDate = {};
      if (startDate) query.pickupDate.$gte = new Date(new Date(startDate).setHours(0, 0, 0, 0));
      if (endDate) query.pickupDate.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
    }

    if (orderType) {
      query.orderType = orderType;
    }

    if (searchQuery) {
      query.$or = [
        { pickupId: { $regex: searchQuery, $options: "i" } },
        { awb_numbers: { $in: [new RegExp(searchQuery, "i")] } },
      ];
    }

    if (pickupContactName || courierServiceName) {
      let orderQuery = {};
      if (userId) orderQuery.userId = userId;

      if (pickupContactName) {
        const names = Array.isArray(pickupContactName)
          ? pickupContactName
          : pickupContactName.includes(",")
            ? pickupContactName.split(",")
            : [pickupContactName];
        orderQuery["pickupAddress.contactName"] = { $in: names };
      }

      if (courierServiceName) {
        const couriers = Array.isArray(courierServiceName)
          ? courierServiceName
          : courierServiceName.includes(",")
            ? courierServiceName.split(",")
            : [courierServiceName];
        orderQuery["courierServiceName"] = { $in: couriers };
      }

      const matchingOrders = await Order.find(orderQuery).select("_id");
      const matchingOrderIds = matchingOrders.map((o) => o._id);

      if (matchingOrderIds.length > 0) {
        query.orderIds = { $in: matchingOrderIds };
      } else {
        // If filters are provided but no orders match, the manifest list should be empty
        query.orderIds = { $in: [new mongoose.Types.ObjectId()] };
      }
    }

    // To get filter options (locations/couriers), we get unique distinct values directly from PickupManifest
    let filterOptionsQuery = {};
    if (userId) filterOptionsQuery.userId = userId;
    if (orderType) filterOptionsQuery.orderType = orderType;

    const [pickupLocations, courierServices] = await Promise.all([
      PickupManifest.distinct("pickupAddress.contactName", filterOptionsQuery),
      PickupManifest.distinct("courierServiceNames", filterOptionsQuery),
    ]);

    const manifests = await PickupManifest.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate("userId", "fullname email phoneNumber company userId")
      .populate({
        path: "orderIds",
        populate: { path: "userId", select: "fullname email phoneNumber company userId" }
      });

    const total = await PickupManifest.countDocuments(query);

    return res.status(200).json({
      success: true,
      manifests,
      totalPages: Math.ceil(total / limit),
      total,
      pickupLocations,
      courierServices
    });
  } catch (error) {
    console.error("getPickupManifests error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const filterPickupManifestsForAdmin = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      startDate,
      endDate,
      searchQuery,
      orderId,
      awbNumber,
      pickupContactName,
      courierServiceName,
      orderType,
      userId,
    } = req.query;

    let query = {};
    const isSpecificSearch = searchQuery || orderId || awbNumber;

    // For Admin/Employee, allow filtering by userId
    if (userId) {
      query.userId = new mongoose.Types.ObjectId(userId);
    }

    // Handle Employee role allocations
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });

      const allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());

      if (allocatedUserIds.length === 0) {
        return res.json({
          success: true,
          manifests: [],
          totalPages: 0,
          total: 0,
        });
      }

      if (userId) {
        if (!allocatedUserIds.includes(userId.toString())) {
          return res.json({
            success: true,
            manifests: [],
            totalPages: 0,
            total: 0,
          });
        }
      } else {
        query.userId = {
          $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
        };
      }
    }

    if (startDate || endDate) {
      // If a specific ID/Search is used, we bypass the date filter to find existing manifests
      if (!isSpecificSearch || (searchQuery && searchQuery.length < 3)) {
        query.pickupDate = {};
        if (startDate) query.pickupDate.$gte = new Date(new Date(startDate).setHours(0, 0, 0, 0));
        if (endDate) query.pickupDate.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
      }
    }

    if (orderType) {
      query.orderType = orderType;
    }

    if (isSpecificSearch) {
      const orConditions = [];

      // Global search for pickupId, AWB or User details (Admin Global Search)
      if (searchQuery && typeof searchQuery === "string") {
        const trimmedSearch = searchQuery.trim();
        orConditions.push({ pickupId: { $regex: trimmedSearch, $options: "i" } });
        orConditions.push({ awb_numbers: { $regex: trimmedSearch, $options: "i" } });
        
        // 1. Build User Search (Only strings for regex, numbers for exact match)
        const userSearchConditions = [
          { fullname: { $regex: trimmedSearch, $options: "i" } },
          { email: { $regex: trimmedSearch, $options: "i" } },
        ];

        // Only search by numeric userId if the string is purely digits
        if (/^\d+$/.test(trimmedSearch)) {
          userSearchConditions.push({ userId: Number(trimmedSearch) });
        }

        const matchedUsers = await User.find({ $or: userSearchConditions }).select("_id");
        if (matchedUsers.length > 0) {
          orConditions.push({ userId: { $in: matchedUsers.map(u => u._id) } });
        }

        // 2. Build Order Search for global query (numerical orderId)
        if (/^\d+$/.test(trimmedSearch)) {
          const matchingOrders = await Order.find({ orderId: Number(trimmedSearch) }).select("_id");
          if (matchingOrders.length > 0) {
            orConditions.push({ orderIds: { $in: matchingOrders.map(o => o._id) } });
          }
        }
      }

      // 3. Explicit Order ID search (from filter box)
      if (orderId && !isNaN(Number(orderId))) {
        const explicitOrders = await Order.find({ orderId: Number(orderId) }).select("_id");
        if (explicitOrders.length > 0) {
          orConditions.push({ orderIds: { $in: explicitOrders.map(o => o._id) } });
        }
      }

      // 4. Explicit AWB Search (from filter box)
      if (awbNumber) {
        const explicitAwb = awbNumber.trim();
        orConditions.push({ awb_numbers: { $regex: explicitAwb, $options: "i" } });
        const ordersByAwb = await Order.find({ awb_number: { $regex: explicitAwb, $options: "i" } }).select("_id");
        if (ordersByAwb.length > 0) {
          orConditions.push({ orderIds: { $in: ordersByAwb.map(o => o._id) } });
        }
      }

      if (orConditions.length > 0) {
        query.$or = orConditions;
      }
    }

    if (pickupContactName || courierServiceName) {
      let orderQuery = {};
      if (query.userId) orderQuery.userId = query.userId;

      if (pickupContactName) {
        const names = Array.isArray(pickupContactName)
          ? pickupContactName
          : pickupContactName.includes(",")
            ? pickupContactName.split(",")
            : [pickupContactName];
        orderQuery["pickupAddress.contactName"] = { $in: names };
      }

      if (courierServiceName) {
        const couriers = Array.isArray(courierServiceName)
          ? courierServiceName
          : courierServiceName.includes(",")
            ? courierServiceName.split(",")
            : [courierServiceName];
        orderQuery["courierServiceName"] = { $in: couriers };
      }

      const matchingOrders = await Order.find(orderQuery).select("_id");
      const matchingOrderIds = matchingOrders.map((o) => o._id);

      if (matchingOrderIds.length > 0) {
        query.orderIds = { $in: matchingOrderIds };
      } else {
        // If filters are provided but no orders match, the manifest list should be empty
        query.orderIds = { $in: [new mongoose.Types.ObjectId()] };
      }
    }

    const manifests = await PickupManifest.find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate("userId", "fullname email phoneNumber company userId")
      .populate("orderIds");

    const total = await PickupManifest.countDocuments(query);

    // Get distinct filter options from matching manifests directly without populating orders
    const [pickupLocations, courierServices] = await Promise.all([
      PickupManifest.distinct("pickupAddress.contactName", query),
      PickupManifest.distinct("courierServiceNames", query),
    ]);

    return res.status(200).json({
      success: true,
      manifests,
      totalPages: Math.ceil(total / limit),
      total,
      pickupLocations,
      courierServices
    });
  } catch (error) {
    console.error("filterPickupManifestsForAdmin error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getManifestOrders = async (req, res) => {
  try {
    const { manifestId } = req.params;
    let manifest;
    if (mongoose.Types.ObjectId.isValid(manifestId)) {
      manifest = await PickupManifest.findById(manifestId).populate({
        path: "orderIds",
        populate: { path: "userId", select: "fullname email phoneNumber company userId" }
      });
    } else {
      manifest = await PickupManifest.findOne({ pickupId: manifestId }).populate({
        path: "orderIds",
        populate: { path: "userId", select: "fullname email phoneNumber company userId" }
      });
    }
    if (!manifest) {
      return res.status(404).json({ message: "Manifest not found" });
    }
    return res.status(200).json({
      success: true,
      manifest,
      orders: manifest.orderIds,
    });
  } catch (error) {
    console.error("getManifestOrders error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// callPickupProvider removed as requested — provider APIs call handled during booking level if needed

const generatePickupId = async (isB2B = false) => {
  const counter = await PickupManifestCounter.findOneAndUpdate(
    { date: "global_counter" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const prefix = isB2B ? "SHPI-B2B" : "SHPI";
  return `${prefix}-${counter.seq}`;
};

module.exports = {
  assignPickupManifest,
  removeFromPickupManifest,
  getPickupManifests,
  getManifestOrders,
  filterPickupManifestsForAdmin,
};
