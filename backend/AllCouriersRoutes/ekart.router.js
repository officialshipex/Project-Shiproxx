const express = require('express');


const  {saveEkart}= require('../AllCouriers/Ekart/Authorize/Ekart.controller');
const { orderCreationEkart } = require('../AllCouriers/Ekart/Couriers/couriers.controller');
const { sanitizeJsonResponses } = require('../utils/sanitizeResponseMiddleware');

const router = express.Router();




router.post("/authorize",saveEkart);
router.post("/createShipment", sanitizeJsonResponses, orderCreationEkart);


module.exports = router;