const express = require('express');
const { saveDtdc, getToken } = require('../AllCouriers/DTDC/Authorize/saveCourierContoller');
const { createOrder, cancelOrder, cancelOrderDTDC } = require('../AllCouriers/DTDC/Courier/couriers.controller');
const { sanitizeJsonResponses } = require('../utils/sanitizeResponseMiddleware');
const router = express.Router()



router.post('/getToken', getToken )
router.get('/saveNew',saveDtdc);
router.post('/createShipment', sanitizeJsonResponses, createOrder)
router.post('/cancelOrderDTDC',cancelOrderDTDC)

module.exports = router;