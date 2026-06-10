const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const PickupManifest = require("../../../models/pickupManifest.model");
const PickupManifestCounter = require("../../../models/pickupManifestCounter.model");

const schedulePickup = async (req, res) => {
    try {
        const { orderIds, pickupDate } = req.body;

        if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0 || !pickupDate) {
            return res
                .status(400)
                .json({ message: "orderIds (array) and pickupDate required" });
        }

        const pickupDateObj = new Date(pickupDate);
        pickupDateObj.setHours(0, 0, 0, 0);

        let successCount = 0;
        let failedOrders = [];

        // Process each order
        for (const orderId of orderIds) {
            try {
                const order = await Order.findById(orderId);
                if (!order) {
                    failedOrders.push({ orderId, reason: "Order not found" });
                    continue;
                }

                if (order.status !== "Booked") {
                    failedOrders.push({ orderId, reason: `Order is in ${order.status} status, expected Booked` });
                    continue;
                }

                // 1️⃣ Call provider pickup API
                const pickupResponse = await callPickupProvider(order.provider, {
                    order,
                    pickupDate,
                });

                if (!pickupResponse?.success) {
                    failedOrders.push({ orderId, reason: pickupResponse?.message || "Pickup scheduling failed at provider" });
                    continue;
                }

                // 2️⃣ Normalize pickup date (date-based manifest) + orderType B2B + pickupAddress
                let manifest = await PickupManifest.findOne({
                    userId: order.userId,
                    pickupDate: pickupDateObj,
                    orderType: "B2B",
                    "pickupAddress.address": order.pickupAddress?.address,
                    "pickupAddress.contactName": order.pickupAddress?.contactName,
                    "pickupAddress.pincode": order.pickupAddress?.pincode,
                });

                // 3️⃣ Create new manifest if not exists
                if (!manifest) {
                    const dateStr = pickupDateObj.toISOString().split("T")[0];
                    const pickupId = await generatePickupId(dateStr, true);

                    manifest = await PickupManifest.create({
                        userId: order.userId,
                        pickupId,
                        pickupDate: pickupDateObj,
                        status: "Pickup_Scheduled",
                        orderIds: [order._id],
                        awb_numbers: order.awb_number ? [order.awb_number] : [],
                        providers: [order.provider],
                        courierServiceNames: order.courierServiceName
                            ? [order.courierServiceName]
                            : [],
                        orderType: "B2B",
                        pickupAddress: order.pickupAddress,
                    });
                } else {
                    // 4️⃣ Update existing manifest safely (NO DUPLICATES)
                    if (!manifest.orderIds.some((id) => id.equals(order._id))) {
                        manifest.orderIds.push(order._id);
                    }

                    if (
                        order.awb_number &&
                        !manifest.awb_numbers.includes(order.awb_number)
                    ) {
                        manifest.awb_numbers.push(order.awb_number);
                    }

                    if (order.provider && !manifest.providers.includes(order.provider)) {
                        manifest.providers.push(order.provider);
                    }

                    if (
                        order.courierServiceName &&
                        !manifest.courierServiceNames.includes(order.courierServiceName)
                    ) {
                        manifest.courierServiceNames.push(order.courierServiceName);
                    }

                    manifest.status = "Pickup_Scheduled";
                    await manifest.save();
                }

                // 5️⃣ Update order status
                order.status = "Ready To Ship";
                await order.save();
                successCount++;
            } catch (err) {
                console.error(`Error scheduling pickup for B2B order ${orderId}:`, err);
                failedOrders.push({ orderId, reason: err.message });
            }
        }

        return res.status(200).json({
            success: true,
            message: `${successCount} pickups scheduled successfully`,
            failedCount: failedOrders.length,
            failedOrders,
        });
    } catch (error) {
        console.error("schedulePickup B2B error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

const getPickupManifests = async (req, res) => {
    try {
        const { page = 1, limit = 20, startDate, endDate, searchQuery, pickupContactName, courierServiceName } = req.query;

        const userId = req.user?._id;

        let query = { orderType: "B2B" };
        if (userId) query.userId = userId;

        if (startDate || endDate) {
            query.pickupDate = {};
            if (startDate) query.pickupDate.$gte = new Date(new Date(startDate).setHours(0, 0, 0, 0));
            if (endDate) query.pickupDate.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
        }

        if (searchQuery) {
            query.$or = [
                { pickupId: { $regex: searchQuery, $options: "i" } },
                { awb_numbers: { $in: [new RegExp(searchQuery, "i")] } },
            ];
        }

        if (pickupContactName || courierServiceName) {
            let orderQuery = { orderType: "B2B" };
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
        let filterOptionsQuery = { orderType: "B2B" };
        if (userId) filterOptionsQuery.userId = userId;

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
                path: 'orderIds',
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
        console.error("getPickupManifests B2B error:", error);
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
            manifest = await PickupManifest.findOne({ pickupId: manifestId, orderType: "B2B" }).populate({
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
        console.error("getManifestOrders B2B error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};

const callPickupProvider = async (provider, payload) => {
    try {
        const providerLower = provider?.toLowerCase().trim();
        switch (providerLower) {
            case "dtdc":
                return { success: true };

            case "delhivery":
                const { createDelhiveryPickupRequest } = require("../Couriers/AllCouriers/Delhivery/Courier/couriers.controller");
                return await createDelhiveryPickupRequest(payload.order);

            case "amazon shipping":
                return { success: true };

            case "shree maruti":
                return { success: true };

            case "zipypost":
                return { success: true };

            case "ekart":
                return { success: true };

            default:
                return { success: true };
        }
    } catch (error) {
        console.error(`B2B Pickup provider error for ${provider}:`, error);
        return { success: false, message: error.message };
    }
};

const generatePickupId = async (dateStr, isB2B = false) => {
    const counter = await PickupManifestCounter.findOneAndUpdate(
        { date: "global_counter" },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );

    const prefix = isB2B ? "SHPI-B2B" : "SHPI";
    return `${prefix}-${counter.seq}`;
};

module.exports = {
    getPickupManifests,
    getManifestOrders,
    schedulePickup
};
