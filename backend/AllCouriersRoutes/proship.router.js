const express = require("express");
const router = express.Router();
const { saveProship } = require("../AllCouriers/Proship/Authorize/proship.controller");
const { createProshipOrder } = require("../AllCouriers/Proship/Courier/couriers.controller");
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");

router.post("/getAuthToken", saveProship);
router.post("/createShipment", sanitizeJsonResponses, createProshipOrder);

module.exports = router;
