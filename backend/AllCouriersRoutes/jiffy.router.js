const express = require("express");
const router = express.Router();
const jiffyAuth = require("../AllCouriers/Jiffy/Authorize/jiffy.controller");
const jiffyCouriers = require("../AllCouriers/Jiffy/Courier/couriers.controller");

router.post("/addCourier", jiffyAuth.getAuthToken);
router.post("/createShipment", jiffyCouriers.createJiffyShipment);
router.get("/ndr-list", jiffyCouriers.getJiffyNdrList);

module.exports = router;
