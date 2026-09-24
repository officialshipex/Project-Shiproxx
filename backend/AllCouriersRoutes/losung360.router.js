const express = require("express");
const router = express.Router();
const { saveLosung360 } = require("../AllCouriers/Losung360/Authorize/losung360.controller");
const { createOrder } = require("../AllCouriers/Losung360/Courier/couriers.controller");
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");

router.post("/getAuthToken", saveLosung360);
router.post("/createShipment", sanitizeJsonResponses, createOrder);

module.exports = router;

