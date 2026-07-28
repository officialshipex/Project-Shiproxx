const express=require("express");
const router=express.Router();

const { isAuthorized } = require("../../middleware/auth.middleware");
const orderCreationController = require("../Controller/orderCreation.controller");
const { generateToken, generateTokenWithoutPassword } = require("../Controller/tokenGeneration.controller");
const pincodeServiceability = require("../Controller/pincodeServiceability.controller");
const availableCourierService=require("../Controller/availableCourierService.controller")
const bookOrder= require("../Controller/bookOrder.controller");
const getOrderDetails = require("../Controller/getOrderDetails.controller");
const cancelOrdersAtBooked = require("../Controller/cancelledOrder.controller");
const trackOrder = require("../Controller/trackOrder.controller");
const generateLabel=require("../Controller/labelGeneration.controller")
const { exceptionList,ndrCreate } = require("../Controller/NDR.controller");
const createPickupAddress=require("../Controller/warehouseCreation.controller")
const generateManifest=require("../Controller/manifestGeneration.controller")


// Route to create a new order
router.post("/external/createOrder", isAuthorized, orderCreationController);
router.post("/external/generateToken", generateToken);
router.post("/external/generateTokenWithoutPassword", generateTokenWithoutPassword);
router.post("/external/pincodeServiceability", isAuthorized, pincodeServiceability);
router.post("/external/serviceableCourierServices/rate", isAuthorized, availableCourierService);
router.post("/external/orderBooking",isAuthorized, bookOrder);
router.get("/external/getOrder/:orderId", isAuthorized, getOrderDetails);
router.post("/external/cancelledOrder/:awb_number", isAuthorized, cancelOrdersAtBooked);
router.post("/external/trackOrder", trackOrder);
router.get("/external/generateLabel/:awb",isAuthorized,generateLabel);
router.post("/external/generateManifest",isAuthorized,generateManifest)
router.get("/external/exceptionList",isAuthorized,exceptionList)
router.post("/external/ndr/create",isAuthorized,ndrCreate);
router.post("/external/createPickupAddress",isAuthorized,createPickupAddress)


module.exports = router;