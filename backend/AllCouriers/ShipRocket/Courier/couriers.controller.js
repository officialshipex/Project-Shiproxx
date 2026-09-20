if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const mongoose = require("mongoose");
const AllCourier = require("../../../models/AllCourierSchema");
const CourierService = require("../../../models/CourierService.Schema");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const { getAuthToken } = require("../Authorize/shiprocket.controller");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");
const createShiprocketShipment = require("../../../API/Courier/shiprocketShipmentCreation.controller");
const axios = require("axios");
const { createTtlMemo } = require("../../../utils/ttlMemo");

const BASE_URL = `${process.env.SHIPROCKET_URL}/v1/external`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const cleanPhone = (phone) => {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

// ─── Courier Setup (Admin) ────────────────────────────────────────────────────
const getAllActiveCourierServices = async (req, res) => {
  try {
    const token = await getAuthToken();
    if (!token) return res.status(500).json({ message: "ShipRocket authentication failed." });

    const response = await axios.get(`${BASE_URL}/courier/courierListWithCounts?type=active`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    // console.log("all service", response.data)

    if (response?.data?.courier_data) {
      const allServices = response.data.courier_data.map((element) => ({
        service: element.name,
        courier_id: element.id,
      }));
      return res.status(200).json(allServices);
    }

    return res.status(400).json({ message: "Failed to fetch courier services." });
  } catch (error) {
    console.error("ShipRocket getAllActiveCourierServices Error:", error.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to fetch courier services.",
      error: error.response?.data || error.message,
    });
  }
};

// ─── Main Services ────────────────────────────────────────────────────────────
const getAllPickupLocations = async () => {
  try {
    const token = await getAuthToken();
    if (!token) return null;
    const response = await axios.get(`${BASE_URL}/settings/company/pickup`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    
    let locations = [];
    if (response.data?.data?.shipping_address && Array.isArray(response.data.data.shipping_address)) {
      locations = response.data.data.shipping_address;
    } else if (response.data?.data && Array.isArray(response.data.data)) {
      locations = response.data.data;
    } else if (response.data && Array.isArray(response.data)) {
      locations = response.data;
    } else if (response.data?.shipping_address && Array.isArray(response.data.shipping_address)) {
      locations = response.data.shipping_address;
    }
    return locations;
  } catch (error) {
    console.error("ShipRocket getAllPickupLocations Error:", error.response?.data || error.message);
    return null;
  }
};

const addPickupLocation = async (pickupData) => {
  try {
    const token = await getAuthToken();
    if (!token) return null;

    const requestData = {
      pickup_location: pickupData.warehouseName || pickupData.contactName,
      name: pickupData.contactName || "",
      email: pickupData.email || "info@shiproxx.com",
      phone: cleanPhone(pickupData.phoneNumber) || "9999999999",
      address: pickupData.address,
      address_2: pickupData.address2 || "",
      city: pickupData.city,
      state: pickupData.state,
      country: "India",
      pin_code: String(pickupData.pinCode),
    };

    const response = await axios.post(`${BASE_URL}/settings/company/addpickup`, requestData, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return response.data;
  } catch (error) {
    if (error.response?.status !== 422) {
      console.error("ShipRocket addPickupLocation Error:", error.response?.data || error.message);
    }
    return null;
  }
};

const requestShipmentPickup = async (shipment_id) => {
  try {
    const token = await getAuthToken();
    if (!token) return { success: false, message: "Auth failed" };

    const response = await axios.post(`${BASE_URL}/courier/generate/pickup`, { shipment_id: [shipment_id] }, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 15000,
    });

    if (response.data?.pickup_status === 1 || response.data?.response?.pickup_scheduled_date) {
      return { success: true, data: response.data, message: "Pickup scheduled successfully." };
    }
    return { success: false, message: "Pickup scheduling failed.", data: response.data };
  } catch (error) {
    console.error("ShipRocket requestPickup Error:", error.response?.data || error.message);
    return { success: false, message: error.response?.data?.message || error.message };
  }
};

// Shiprocket's answer depends only on route / COD / weight — never on which of
// our services is asking — and it lists every courier at once. The "Ship Now"
// page checks each enabled service separately, so one page open used to send
// the identical request 15 times. Share one request among callers for a short
// while instead; each caller still filters for its own courier below.
const serviceabilityMemo = createTtlMemo(60 * 1000);

const checkServiceabilityShipRocket = async (payload) => {
  try {
    const { serviceName, origin, destination, payment_type, weight } = payload;
    const shiprocketService = await CourierService.findOne({ name: serviceName, provider: "Shiprocket" })
    if (!shiprocketService) return { success: false }

    const token = await getAuthToken();
    if (!token) return { success: false };
    // console.log("payload", payload)
    const cod = payment_type === true ? 1 : 0;
    const params = {
      pickup_postcode: origin,
      delivery_postcode: destination,
      cod,
      weight: weight || "0.5"
    };

    const available = await serviceabilityMemo(
      `${params.pickup_postcode}|${params.delivery_postcode}|${params.cod}|${params.weight}`,
      async () => {
        const response = await axios.get(`${BASE_URL}/courier/serviceability/`, {
          headers: { Authorization: `Bearer ${token}` },
          params,
          timeout: 10000,
        });
        // Only the two fields the match below needs — keeps the shared entry tiny.
        return (response.data?.data?.available_courier_companies || []).map((item) => ({
          courier_company_id: item.courier_company_id,
          blocked: item.blocked,
        }));
      },
      (list) => list.length > 0
    );
    // console.log(available, "response.data")
    // Match on courier_company_id, not courier_name — Shiprocket's own
    // courier_name is its internal display label bundling courier + service
    // tier + weight slab (e.g. "Delhivery DS 500gm"), which no longer equals
    // our cleaned-up `courier` field (now just "Delhivery"), and was always
    // liable to drift if Shiprocket changed their wording anyway. The
    // numeric company id is what actually identifies the courier and is the
    // same id we already store as courier_id for the AWB-assignment call.
    const matched = available.filter(
      (item) => String(item.courier_company_id) === String(shiprocketService.courier_id) && item.blocked === 0
    );
    // console.log(matched, "matched")
    return { success: matched.length > 0 };
  } catch (error) {
    console.error("ShipRocket checkServiceability Error:", error.response?.data || error.message);
    return { success: false, message: error.message };
  }
};

const getTrackingByAWB = async (awb_code) => {
  try {
    const token = await getAuthToken();
    if (!token) return { success: false, data: [] };

    const response = await axios.get(`${BASE_URL}/courier/track/awb/${awb_code}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });

    const trackingData = response.data?.tracking_data;
    // console.log("tracking",trackingData)
    if (!trackingData) return { success: false, data: [] };

    const shipment = trackingData.shipment_track?.[0] || {};
    const activities = trackingData.shipment_track_activities || [];
    if (!activities.length) return { success: false, data: [] };

    const normalised = activities.map((a) => ({
      current_status: a.status || "",
      location: a.location || "",
      timestamp: a.date || null,
      instructions: a.activity || a.status || "",
      shipment_status: shipment.shipment_status || null,
    })).reverse();

    return { success: true, data: normalised, shipment_status: shipment.shipment_status || null };
  } catch (error) {
    console.error("ShipRocket getTrackingByAWB Error:", error.response?.data || error.message);
    return { success: false, data: [] };
  }
};
// getTrackingByAWB("SF3698223623HIR")

const cancelOrder = async (awb_number) => {
  try {
    const token = await getAuthToken();
    if (!token) return { success: false, message: "Auth failed" };

    const response = await axios.post(`${BASE_URL}/orders/cancel/shipment/awbs`, { awbs: [String(awb_number)] }, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 15000,
    });
    return { success: true, data: response.data };
  } catch (error) {
    console.error("ShipRocket cancelOrder Error:", error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
};

const generateLabel = async (shipment_id) => {
  try {
    const token = await getAuthToken();
    if (!token) return null;
    const response = await axios.get(`${BASE_URL}/courier/generate/label`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { shipment_id },
      timeout: 15000,
    });
    return response.data?.label_url || null;
  } catch (error) {
    console.error("ShipRocket generateLabel Error:", error.response?.data || error.message);
    return null;
  }
};

const createCustomOrder = async (req, res) => {
  try {
    const { id, finalCharges, courierServiceName, provider, priceBreakup } = req.body;

    // Fetch order to get userId
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Fetch user to get Wallet ID
    const user = await User.findById(order.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Fetch wallet details
    const wallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit");
    if (!wallet) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }

    const result = await createShiprocketShipment({
      id,
      provider: provider || "Shiprocket",
      finalCharges,
      courierServiceName,
      priceBreakup,
      userId: order.userId,
      walletId: user.Wallet,
      walletBalance: wallet.balance,
      walletHoldAmount: wallet.holdAmount || 0,
      walletCreditLimit: wallet.creditLimit || 0,
    });

    if (result.success) {
      return res.status(200).json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getAllActiveCourierServices,
  createCustomOrder,
  cancelOrder,
  checkServiceabilityShipRocket,
  addPickupLocation,
  requestShipmentPickup,
  getTrackingByAWB,
  getAllPickupLocations,
  generateLabel,
};
