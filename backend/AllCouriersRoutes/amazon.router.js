const express = require("express");

const {getToken}=require("../AllCouriers/Amazon/Authorize/saveCourierController")
const {createOneClickShipment,
    cancelShipment,
    getShipmentTracking,
    checkAmazonServiceability,}=require("../AllCouriers/Amazon/Courier/couriers.controller")
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");

const router=express.Router();
router.post("/createShipment", sanitizeJsonResponses, createOneClickShipment)

router.post("/getToken",getToken);
router.post("/cancelShipment",cancelShipment);

module.exports=router;