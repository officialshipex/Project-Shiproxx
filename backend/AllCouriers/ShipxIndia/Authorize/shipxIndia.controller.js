const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

let cachedToken = null;
let tokenExpiresAt = 0;

const getShipexToken = async () => {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  let email = process.env.SHIPEX_EMAIL;
  let password = process.env.SHIPEX_PASSWORD;

  // Fallback to database configuration
  try {
    const doc = await AllCourier.findOne({ courierProvider: "ShipexIndia" });
    if (doc) {
      if (doc.email) email = doc.email;
      if (doc.password) password = doc.password;
    }
  } catch (e) {
    console.error("Error loading ShipexIndia credentials from DB:", e.message);
  }

  if (!email || !password) {
    console.warn("⚠️ ShipexIndia credentials are not configured in environment variables or database.");
    return null;
  }

  try {
    const response = await axios.post(
      "https://api.shipexindia.com/v1/api/external/generateToken",
      { email, password },
      { headers: { "Content-Type": "application/json" } }
    );

    if (response.data && response.data.success && response.data.data?.token) {
      cachedToken = response.data.data.token;
      // Cache for 20 hours (token expires in 24 hours)
      tokenExpiresAt = now + 20 * 60 * 60 * 1000;
      return cachedToken;
    }
    return null;
  } catch (error) {
    console.error("ShipexIndia Token Error:", error.response?.data || error.message);
    return null;
  }
};

const getAuthToken = async (req, res) => {
  const url = "https://api.shipexindia.com/v1/api/external/generateToken";
  const { username, password } = req.body.credentials || {};

  const payload = {
    email: username,
    password: password,
  };

  const courierData = {
    courierName: req.body.courierName,
    courierProvider: req.body.courierProvider,
    CODDays: req.body.CODDays,
    status: req.body.status,
    email: username,
    password: password,
  };

  try {
    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
    });

    if (response.data && response.data.success) {
      // Clean up previous ShipexIndia configuration if exists
      await AllCourier.deleteMany({ courierProvider: "ShipexIndia" });

      const newCourier = new AllCourier(courierData);
      await newCourier.save();
      res.status(201).json({ message: "ShipexIndia Integrated Successfully" });
    } else {
      res.status(401).json({ message: response.data?.message || "Authentication failed" });
    }
  } catch (error) {
    console.error("ShipexIndia Auth Error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: error.response?.data?.message || error.message,
    });
  }
};

module.exports = { getShipexToken, getAuthToken };
