const express = require("express");
const router = express.Router();
const { saveShipMaxx } = require("../AllCouriers/ShipMaxx/Authorize/shipmaxx.controller");
const { createOrder, getShipMaxxNdrList } = require("../AllCouriers/ShipMaxx/Courier/couriers.controller");

router.post("/getAuthToken", saveShipMaxx);
router.post("/createShipment", createOrder);
router.get("/ndr-list", getShipMaxxNdrList);

module.exports = router;
