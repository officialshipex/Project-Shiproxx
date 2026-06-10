const express = require("express");
const {
  newOrder,
  getOrders,
  getOrdersByNdrStatus,
  updatedStatusOrders,
  getOrdersById,
  getpickupAddress,
  downloadPickupAddressesExcel,
  newPickupAddress,
  newReciveAddress,
  getreceiverAddress,
  searchReceiver,
  ShipeNowOrder,
  getPinCodeDetails,
  cancelOrdersAtNotShipped,
  cancelOrdersAtBooked,
  updateOrder,
  passbook,
  getUser,
  updatePackageDetails,
  GetTrackingByAwb,
  GetTrackingByAwbs,
  updatePickupAddress,
  setPrimaryPickupAddress,
  deletePickupAddress,
  getShippingOrders,
  bulkCancelOrder,
  checkBulkPickup,
  bulkCloneOrders,
  checkBulkUser,
  checkCourier,
  updateProductDetails,
  masterSearch
} = require("../Orders/newOrder.controller");
const { getPickupManifests, getManifestOrders } = require("../Orders/scheduledPickup.controller");
const router = express.Router();

// Route to create a shipment
router.put("/updateOrder/:orderId", updateOrder);
router.post("/neworder", newOrder);
router.get("/orders", getOrders);
router.get("/shippingOrders", getShippingOrders);
router.get("/ndr", getOrdersByNdrStatus);
router.post("/clone", updatedStatusOrders);
router.post("/bulkClone", bulkCloneOrders);
router.get("/getOrderById/:id", getOrdersById);
router.get("/pickupAddress", getpickupAddress);
router.get("/pickupAddress/download-excel", downloadPickupAddressesExcel);
router.get("/receiverAddress", getreceiverAddress);
router.get("/searchReceiver", searchReceiver);
router.post("/pickupAddress", newPickupAddress);
router.post("/receiverAddress", newReciveAddress);
router.get("/ship/:id", ShipeNowOrder);
router.get("/pincode/:pincode", getPinCodeDetails);
router.post("/cancelOrdersAtNotShipped", cancelOrdersAtNotShipped);
router.post("/cancelOrdersAtBooked", cancelOrdersAtBooked);
router.post("/updatePackageDetails", updatePackageDetails);
router.get("/passbook", passbook);
router.get("/getUser", getUser);
router.get("/GetTrackingByAwb/:awb", GetTrackingByAwb);
router.post("/GetTrackingByAwbs", GetTrackingByAwbs);
router.put("/updatePickupAddress/:id", updatePickupAddress);
router.patch("/pickupAddress/setPrimary/:id", setPrimaryPickupAddress);
router.delete("/pickupAddress/:id", deletePickupAddress);
router.post("/bulkCancelOrder", bulkCancelOrder);
router.get("/checkBulkPickup", checkBulkPickup);
router.get("/checkBulkUser", checkBulkUser);
router.get("/checkCourier/:id", checkCourier);
router.put("/updateProductDetails/:orderId", updateProductDetails);
router.get("/masterSearch", masterSearch);


// router.post("/schedulePickup", schedulePickup);
router.get("/pickupManifests", getPickupManifests);
router.get("/pickupManifest/:manifestId", getManifestOrders);
router.get("/manifestOrders/:manifestId", getManifestOrders);

module.exports = router;
