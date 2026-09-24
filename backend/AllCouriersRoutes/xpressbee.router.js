const express = require("express");
const router = express.Router();

const XpressbeesAuthorizeController=require("../AllCouriers/Xpressbees/Authorize/XpressbeesAuthorize.controller");
const XpressbeesCouierController=require("../AllCouriers/Xpressbees/Courier/courier.controller");
const XpressbeesMainServices=require("../AllCouriers/Xpressbees/MainServices/mainServices.controller");
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");

router.post('/getAuthToken',XpressbeesAuthorizeController.getAuthToken);
router.get('/saveNew',XpressbeesAuthorizeController.saveXpressbees);
router.get('/isEnabeled',XpressbeesAuthorizeController.isEnabeled);
router.get('/disable',XpressbeesAuthorizeController.disable);
router.get('/enable',XpressbeesAuthorizeController.enable);

router.get('/getCourierList',XpressbeesCouierController.getCourierList);
router.post("/addService",XpressbeesCouierController.addService);

router.post("/createShipment", sanitizeJsonResponses, XpressbeesMainServices.createShipment);

module.exports=router;