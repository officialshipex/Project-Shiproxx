const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

const LOSUNG360_EMAIL = process.env.LOSUNG360_EMAIL || "sandeep@shipexindia.com";
const LOSUNG360_PASSWORD = process.env.LOSUNG360_PASSWORD || "Shipex@123";
const LOSUNG360_BASE_URL = "https://appapi.losung360.com/external/v1";

let cachedToken = null;
let tokenFetchTime = null;

const getLosung360AccessToken = async () => {
  const currentTime = Date.now();
  if (cachedToken && tokenFetchTime && (currentTime - tokenFetchTime < 23 * 60 * 60 * 1000)) {
    return cachedToken;
  }

  let email = null;
  let password = null;

  try {
    let dbCredentials = await AllCourier.findOne({ courierProvider: "Losung360", status: "Enable" });
    if (!dbCredentials) {
      dbCredentials = await AllCourier.findOne({ courierProvider: "Losung360" });
    }
    if (dbCredentials && dbCredentials.email && dbCredentials.password) {
      email = dbCredentials.email;
      password = dbCredentials.password;
    }
  } catch (err) {
    console.error("Error fetching Losung360 credentials from DB:", err.message);
  }

  if (!email || !password) {
    email = LOSUNG360_EMAIL;
    password = LOSUNG360_PASSWORD;
  }

  try {
    const response = await axios.post(
      `${LOSUNG360_BASE_URL}/auth/login`,
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
    console.error("Losung360 Auth Error:", error?.response?.data || error.message);
    return null;
  }
};

const saveLosung360 = async (req, res) => {
  const { username, password } = req.body.credentials || {};
  const { courierName, courierProvider, CODDays, status } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ message: "Username/Email and password are required." });
  }

  try {
    const loginResponse = await axios.post(
      `${LOSUNG360_BASE_URL}/auth/login`,
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
    courierProvider,
    CODDays,
    status,
    email: username,
    password: password,
  };

  try {
    cachedToken = null;
    tokenFetchTime = null;

    const newCourier = new AllCourier(courierData);
    await newCourier.save();

    return res.status(201).json({
      message: "Losung360 courier successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to add Losung360 courier.",
      error: error.message,
    });
  }
};

module.exports = { saveLosung360, getLosung360AccessToken };
