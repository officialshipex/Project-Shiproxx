const AppNotification = require("../models/appNotification.model");
const BulkShipJob = require("../models/bulkShipJob.model");
const BulkOrderFiles = require("../model/bulkOrderFiles.model");
const { getActor } = require("../Orders/bulkShipJob.controller");

// Fields safe to expose in the list view — summary/counts only, never the
// full per-order/per-row result arrays (those are fetched on demand via
// getNotificationDetail, only for the one notification the user opens).
const SUMMARY_SELECT = "status totalOrders successCount failureCount noOfOrders successfullyUploaded errorOrders";

const listActiveNotifications = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const notifications = await AppNotification.find({
      actorId: actor.id,
      actorType: actor.type,
      dismissed: false,
    })
      .sort("-createdAt")
      .limit(30)
      .populate({ path: "refId", select: SUMMARY_SELECT });

    return res.status(200).json({ success: true, notifications });
  } catch (error) {
    console.error("listActiveNotifications error:", error.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const listNotificationHistory = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { refModel, fromDate, toDate } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    const query = { actorId: actor.id, actorType: actor.type };
    // Deliberately NOT filtering by dismissed — "Show All" must recover
    // anything the user dismissed by mistake before reading it.
    if (refModel === "BulkShipJob" || refModel === "BulkOrderFiles") {
      query.refModel = refModel;
    }
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }

    const [notifications, total] = await Promise.all([
      AppNotification.find(query)
        .sort("-createdAt")
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({ path: "refId", select: SUMMARY_SELECT }),
      AppNotification.countDocuments(query),
    ]);

    return res.status(200).json({ success: true, total, page, limit, notifications });
  } catch (error) {
    console.error("listNotificationHistory error:", error.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const getNotificationDetail = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const notification = await AppNotification.findOne({
      _id: req.params.id,
      actorId: actor.id,
      actorType: actor.type,
    });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    if (notification.refModel === "BulkShipJob") {
      const job = await BulkShipJob.findById(notification.refId);
      if (!job) return res.status(404).json({ success: false, message: "Bulk ship job not found" });
      return res.status(200).json({ success: true, refModel: "BulkShipJob", title: notification.title, job });
    }

    const file = await BulkOrderFiles.findById(notification.refId);
    if (!file) return res.status(404).json({ success: false, message: "Bulk upload file not found" });
    return res.status(200).json({ success: true, refModel: "BulkOrderFiles", title: notification.title, file });
  } catch (error) {
    console.error("getNotificationDetail error:", error.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const dismissNotification = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const notification = await AppNotification.findOneAndUpdate(
      { _id: req.params.id, actorId: actor.id, actorType: actor.type },
      { $set: { dismissed: true } },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.status(200).json({ success: true, notification });
  } catch (error) {
    console.error("dismissNotification error:", error.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = {
  listActiveNotifications,
  listNotificationHistory,
  getNotificationDetail,
  dismissNotification,
};
