const express = require("express");
const router = express.Router();

const { saveShipRocket, getAuthToken } = require("../AllCouriers/ShipRocket/Authorize/shiprocket.controller");
const {
  getAllActiveCourierServices,
  createCustomOrder,
  cancelOrder,
  checkServiceabilityShipRocket,
  requestShipmentPickup,
  getTrackingByAWB,
  getAllPickupLocations,
  generateLabel,
} = require("../AllCouriers/ShipRocket/Courier/couriers.controller");
const { sanitizeJsonResponses } = require("../utils/sanitizeResponseMiddleware");

// ── Auth / Courier Setup ──────────────────────────────────────────────────────
router.post("/getAuthToken", saveShipRocket);

// ── Courier Services (Admin) ──────────────────────────────────────────────────
router.get("/getAllActiveCourierServices", getAllActiveCourierServices);

// ── Shipment ──────────────────────────────────────────────────────────────────
router.post("/createShipment", sanitizeJsonResponses, createCustomOrder);

// ── Pickup ────────────────────────────────────────────────────────────────────
router.get("/pickupLocations", async (req, res) => {
  try {
    const locations = await getAllPickupLocations();
    return res.status(200).json(locations || []);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch pickup locations", error: error.message });
  }
});

// ── Tracking ──────────────────────────────────────────────────────────────────
router.get("/track/:awb_code", async (req, res) => {
  try {
    const result = await getTrackingByAWB(req.params.awb_code);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return res.status(500).json({ message: "Tracking failed", error: error.message });
  }
});

// ── Label ─────────────────────────────────────────────────────────────────────
router.get("/label/:shipment_id", async (req, res) => {
  try {
    const labelUrl = await generateLabel(req.params.shipment_id);
    if (labelUrl) return res.status(200).json({ label_url: labelUrl });
    return res.status(400).json({ message: "Failed to generate label" });
  } catch (error) {
    return res.status(500).json({ message: "Label generation failed", error: error.message });
  }
});

module.exports = router;
