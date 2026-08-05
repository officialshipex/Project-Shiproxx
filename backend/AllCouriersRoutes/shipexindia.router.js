const express = require("express");
const router = express.Router();
const authorizeController = require("../AllCouriers/ShipxIndia/Authorize/shipxIndia.controller");
const shipexController = require("../AllCouriers/ShipxIndia/Courier/couriers.controller");

router.post("/authorize", authorizeController.getAuthToken);
router.post("/createShipment", shipexController.createShipexIndiaShipment);
router.get("/ndr-list", shipexController.getShipexNdrList);

module.exports = router;
