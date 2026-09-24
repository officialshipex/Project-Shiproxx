const express = require('express');


const  {saveSmartShip}= require('../AllCouriers/SmartShip/Authorize/smartShip.controller');
const { orderRegistrationOneStep } = require('../AllCouriers/SmartShip/Couriers/couriers.controller');
const { sanitizeJsonResponses } = require('../utils/sanitizeResponseMiddleware');

const router = express.Router();




router.post("/authorize",saveSmartShip);
router.post("/createShipment", sanitizeJsonResponses, orderRegistrationOneStep);


module.exports = router;