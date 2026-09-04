const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

const JIFFY_BASE_URL = "https://api.jiffy.world";

let cachedToken = null;
let tokenExpiresAt = 0;

const getJiffyToken = async () => {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  let email = process.env.JIFFY_EMAIL;
  let password = process.env.JIFFY_PASSWORD;

  // DB configuration takes precedence over .env fallback
  try {
    const doc = await AllCourier.findOne({ courierProvider: "Jiffy" });
    if (doc) {
      if (doc.email) email = doc.email;
      if (doc.password) password = doc.password;
    }
  } catch (e) {
    console.error("Error loading Jiffy credentials from DB:", e.message);
  }

  if (!email || !password) {
    console.warn("⚠️ Jiffy credentials are not configured in environment variables or database.");
    return null;
  }

  try {
    const response = await axios.post(
      `${JIFFY_BASE_URL}/users/login`,
      { email, password },
      { headers: { "Content-Type": "application/json" } }
    );

    if (response.data && response.data.success && response.data.data?.token) {
      cachedToken = response.data.data.token;
      // Jiffy tokens expire in 180 minutes (response.data.data.expireIn); cache
      // for 170 to leave headroom before the hard expiry.
      tokenExpiresAt = now + 170 * 60 * 1000;
      return cachedToken;
    }
    return null;
  } catch (error) {
    console.error("Jiffy Token Error:", error.response?.data || error.message);
    return null;
  }
};

const getAuthToken = async (req, res) => {
  const { email, password } = req.body.credentials || {};

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const courierData = {
    courierName: req.body.courierName,
    courierProvider: req.body.courierProvider || "Jiffy",
    CODDays: req.body.CODDays,
    status: req.body.status,
    email,
    password,
  };

  try {
    const response = await axios.post(
      `${JIFFY_BASE_URL}/users/login`,
      { email, password },
      { headers: { "Content-Type": "application/json" } }
    );

    if (response.data && response.data.success) {
      // Single-config-row pattern, same as ShipexIndia — only one Jiffy
      // credential set is ever active at a time.
      await AllCourier.deleteMany({ courierProvider: "Jiffy" });

      const newCourier = new AllCourier(courierData);
      await newCourier.save();

      // Reset the module-level cache so the next call picks up the new credentials
      cachedToken = null;
      tokenExpiresAt = 0;

      return res.status(201).json({ message: "Jiffy Integrated Successfully" });
    }
    return res.status(401).json({ message: response.data?.error?.message || "Authentication failed" });
  } catch (error) {
    console.error("Jiffy Auth Error:", error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      message: error.response?.data?.error?.message || error.message,
    });
  }
};

module.exports = { getJiffyToken, getAuthToken, JIFFY_BASE_URL };
