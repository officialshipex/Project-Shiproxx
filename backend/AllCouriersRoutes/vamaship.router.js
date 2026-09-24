const express = require('express');


const  {saveVamaship}= require('../AllCouriers/Vamaship/Authorize/vamaShip.controller');
const { createVamashipShipment } = require('../AllCouriers/Vamaship/Couriers/couriers.controller');
const { sanitizeJsonResponses } = require('../utils/sanitizeResponseMiddleware');

const router = express.Router();




router.post("/authorize",saveVamaship);
router.post("/createShipment", sanitizeJsonResponses, createVamashipShipment);


module.exports = router;