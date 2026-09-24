const express = require('express');


const {saveZipypost}= require('../AllCouriers/Zipypost/Authorize/zipyPost.controller');
const { createZipypostOrder } = require('../AllCouriers/Zipypost/Couriers/couriers.controller');
const { sanitizeJsonResponses } = require('../utils/sanitizeResponseMiddleware');

const router = express.Router();


router.post("/authorize",saveZipypost);
router.post("/createShipment", sanitizeJsonResponses, createZipypostOrder);


module.exports = router;