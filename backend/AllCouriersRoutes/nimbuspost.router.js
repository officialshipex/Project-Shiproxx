const express = require("express");
const router = express.Router();
const axios = require('axios');

const {getAuthToken,saveNimbusPost,isEnabeled,disable,enable}=require("../../backend/AllCouriers/NimbusPost/Authorize/nimbuspost.controller");
const nimbuspostCourierController=require("../AllCouriers/NimbusPost/Couriers/couriers.controller");
const nimbuspostShipmentController=require("../AllCouriers/NimbusPost/Shipments/shipments.controller");
const nimbuspostNDRController=require("../AllCouriers/NimbusPost/NDR/ndr.controller");
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");


router.get('/saveNew',saveNimbusPost);
router.get('/isEnabeled',isEnabeled);
router.get('/disable',disable);
router.get('/enable',enable);

router.post("/getAuthToken",getAuthToken);



router.get("/getCourierServices",nimbuspostCourierController.getCouriers);
router.post("/addService",nimbuspostCourierController.addService);

router.post("/getServiceablePincodes",nimbuspostCourierController.getServiceablePincodes);
// router.post("/getServiceablePincodesData",nimbuspostCourierController.getServiceablePincodesData);

router.post("/createShipment", sanitizeJsonResponses, nimbuspostShipmentController.createShipment);
// router.post("/trackShipment",nimbuspostShipmentController.trackShipment);
router.post("/trackShipmentInBulk",nimbuspostShipmentController.trackShipmentsInBulk);
router.post("/manifest",nimbuspostShipmentController.manifest);
router.post("/cancelShipment",nimbuspostShipmentController.cancelShipment);
router.post("/hyperLocalShipment",nimbuspostShipmentController.createHyperlocalShipment);

router.post("/getNdrDetails",nimbuspostNDRController.getNdrDetails);
router.post("/performNdrActions",nimbuspostNDRController.performNdrActions);


module.exports=router;



