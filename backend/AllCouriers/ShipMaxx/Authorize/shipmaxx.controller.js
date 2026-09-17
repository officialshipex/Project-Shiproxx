const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

const SHIPMAXX_EMAIL = process.env.SHIPMAXX_EMAIL || "abc";
const SHIPMAXX_PASSWORD = process.env.SHIPMAXX_PASSWORD || "abc";
const SHIPMAXX_BASE_URL = "https://appapi.losung360.com/external/v1";

let cachedToken = null;
let tokenFetchTime = null;

const getShipMaxxToken = async () => {
  const currentTime = Date.now();
  if (cachedToken && tokenFetchTime && (currentTime - tokenFetchTime < 23 * 60 * 60 * 1000)) {
    return cachedToken;
  }

  let email = null;
  let password = null;

  // DB configuration takes precedence over .env fallback. The token cache
  // above is in-memory, so it's always empty right after a server
  // restart/deploy — if the very first ShipMaxx call lands while Mongoose is
  // still finishing its initial connection, this query would otherwise
  // buffer and time out (10s), silently falling through to whatever's in
  // .env. Retry a couple of times first so a momentary startup race doesn't
  // immediately give up and attempt a login with placeholder/stale .env
  // credentials (matches the fix applied to Jiffy's token loader).
  let dbErrored = false;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let dbCredentials = await AllCourier.findOne({ courierProvider: "ShipMaxx", status: "Enable" });
      if (!dbCredentials) {
        dbCredentials = await AllCourier.findOne({ courierProvider: "ShipMaxx" });
      }
      if (dbCredentials && dbCredentials.email && dbCredentials.password) {
        email = dbCredentials.email;
        password = dbCredentials.password;
      }
      dbErrored = false;
      break;
    } catch (e) {
      dbErrored = true;
      console.error(`Error loading ShipMaxx credentials from DB (attempt ${attempt}/${maxAttempts}):`, e.message);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  if (dbErrored) {
    console.error("❌ ShipMaxx: could not read credentials from DB after retries — DB may still be reconnecting.");
    return null;
  }

  if (!email || !password) {
    email = SHIPMAXX_EMAIL;
    password = SHIPMAXX_PASSWORD;
  }

  try {
    const response = await axios.post(
      `${SHIPMAXX_BASE_URL}/auth/login`,
      {
        email_id: email,
        password: password,
      },
      { timeout: 8000 }
    );
    const token = response.data?.access_token || null;
    if (token) {
      cachedToken = token;
      tokenFetchTime = currentTime;
    }
    return token;
  } catch (error) {
    console.error("ShipMaxx Auth Error:", error?.response?.data || error.message);
    return null;
  }
};

const saveShipMaxx = async (req, res) => {
  const { username, password } = req.body.credentials || {};
  const { courierName, courierProvider, CODDays, status } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ message: "Username/Email and password are required." });
  }

  try {
    const loginResponse = await axios.post(
      `${SHIPMAXX_BASE_URL}/auth/login`,
      {
        email_id: username,
        password: password,
      },
      { timeout: 8000 }
    );
    if (!loginResponse.data?.access_token) {
      return res.status(400).json({ message: "Invalid credentials. Failed to get token." });
    }
  } catch (error) {
    return res.status(400).json({
      message: "Unauthorized access. Invalid credentials.",
      error: error?.response?.data || error.message,
    });
  }

  const courierData = {
    courierName,
    courierProvider: courierProvider || "ShipMaxx",
    CODDays,
    status,
    email: username,
    password: password,
  };

  try {
    // Single-config-row pattern, same as Losung360/Jiffy/ShipexIndia — only
    // one ShipMaxx credential set is ever active at a time.
    await AllCourier.deleteMany({ courierProvider: "ShipMaxx" });

    cachedToken = null;
    tokenFetchTime = null;

    const newCourier = new AllCourier(courierData);
    await newCourier.save();

    return res.status(201).json({
      message: "ShipMaxx courier successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to add ShipMaxx courier.",
      error: error.message,
    });
  }
};

module.exports = { saveShipMaxx, getShipMaxxToken, SHIPMAXX_BASE_URL };
