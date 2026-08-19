const express = require('express');
const router = express.Router();

const {shipBulkOrder,updatePickup,createBulkOrder}=require("../Orders/newBulkOrders.controller")
const {getBulkShipStatus,getActiveBulkShipJob,acknowledgeBulkShipJob}=require("../Orders/bulkShipJob.controller")


router.post("/updatePickup",updatePickup)
router.post("/shipBulkOrder",shipBulkOrder)
router.post("/create-bulk-order",createBulkOrder);
router.get("/bulk-ship-active",getActiveBulkShipJob);
router.get("/bulk-ship-status/:jobId",getBulkShipStatus);
router.post("/bulk-ship-acknowledge/:jobId",acknowledgeBulkShipJob);
module.exports=router
