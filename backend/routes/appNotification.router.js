const express = require("express");
const router = express.Router();

const {
  listActiveNotifications,
  listNotificationHistory,
  getNotificationDetail,
  dismissNotification,
} = require("../AppNotifications/appNotification.controller");

router.get("/", listActiveNotifications);
router.get("/history", listNotificationHistory);
router.get("/:id/detail", getNotificationDetail);
router.post("/:id/dismiss", dismissNotification);

module.exports = router;
