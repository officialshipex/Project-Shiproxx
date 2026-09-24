const express = require("express");
const router = express.Router();
const { getAuthToken } = require("../AllCouriers/Shadowfax/Authorize/saveCourierController");
const { createOrder } = require("../AllCouriers/Shadowfax/Courier/couriers.controller");
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");

// Add / authenticate courier
router.post("/getAuthToken", getAuthToken);

// Create a shipment order
router.post("/createShipment", sanitizeJsonResponses, createOrder);

module.exports = router;
