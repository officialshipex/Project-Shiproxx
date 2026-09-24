const express = require("express");
const {
  // trackShipment,
  generateShippingLabel,
  createClientWarehouse,
  createOrder
} = require("../AllCouriers/Delhivery/Courier/couriers.controller");

const{saveDelhivery,isEnabeled,getCourierList,enable,disable,addService, getToken}=require("../AllCouriers/Delhivery/Authorize/saveCourierContoller");
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");

const router = express.Router();
router.post('/getToken', getToken )
router.get('/saveNew',saveDelhivery);
router.get('/isEnabeled',isEnabeled);
router.get('/enable',enable);
router.get('/disable',disable);
router.get('/getCourierList',getCourierList);

router.post('/addService',addService);

router.post("/createShipment", sanitizeJsonResponses, createOrder);

// Route to check pincode serviceability
// router.get("/serviceability/:pincode", checkPincodeServiceability);
// Route to track shipment
// router.get("/track/:waybill", trackShipment);

// Route to generate shipping label
router.get("/label/:waybill", generateShippingLabel);
// Route to create a pickup request
// router.post("/pickup", createPickupRequest);
// Route to create a client warehouse
router.post("/warehouse", createClientWarehouse);

module.exports = router;
