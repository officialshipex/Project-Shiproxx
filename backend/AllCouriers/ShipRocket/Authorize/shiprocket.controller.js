if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const axios = require("axios");
const AllCourier = require("../../../models/AllCourierSchema");

const BASE_URL = `${process.env.SHIPROCKET_URL}/v1/external`;
const SHIPROCKET_EMAIL = process.env.SHIPR_GMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPR_PASS;

// Shiprocket tokens are JWTs valid for 10 days, but every helper used to log
// in afresh on each call — a booking made 2-3 logins, a cancel one, and one
// "Ship Now" page open made 15 in parallel. Keep the token instead.
//
// The cache is keyed on the credentials actually in use, and the credential
// lookup below still runs on every call, so editing / disabling / deleting the
// courier in the admin panel takes effect immediately, exactly as before.
// Lifetime follows the token's own `exp` (capped at 24h so a revoked token can
// never linger), concurrent callers share one in-flight login, and a failed
// login is never remembered.
const MAX_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const EXPIRY_SAFETY_MS = 10 * 60 * 1000;

let tokenCache = { key: null, token: null, expiresAt: 0 };
let inflightLogin = null; // { key, promise }

const resetShiprocketTokenCache = () => {
  tokenCache = { key: null, token: null, expiresAt: 0 };
  inflightLogin = null;
};

const credentialKey = (email, password) => `${email}\u0000${password}`;

const tokenLifetimeMs = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    if (payload?.exp) return Math.min(payload.exp * 1000 - Date.now() - EXPIRY_SAFETY_MS, MAX_TOKEN_TTL_MS);
  } catch (e) {
    // not a decodable JWT — fall through to the conservative default
  }
  return FALLBACK_TOKEN_TTL_MS;
};

const loginToShiprocket = async (loginEmail, loginPassword) => {
  try {
    const response = await axios.post(
      `${BASE_URL}/auth/login`,
      { email: loginEmail, password: loginPassword },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    // console.log(response.data.token)
    if (response.data?.token) return response.data.token;
    console.error("ShipRocket getAuthToken: No token in response");
    return null;
  } catch (error) {
    console.error("ShipRocket Auth Error:", error.response?.data || error.message);
    return null;
  }
};

const getAuthToken = async () => {
  const shiprocketCredentials = await AllCourier.findOne({ courierProvider: "Shiprocket", status: "Enable" });

  const loginEmail = shiprocketCredentials?.email || process.env.SHIPR_GMAIL;
  const loginPassword = shiprocketCredentials?.password || process.env.SHIPR_PASS;
  const key = credentialKey(loginEmail, loginPassword);

  if (tokenCache.key === key && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  if (inflightLogin && inflightLogin.key === key) return inflightLogin.promise;

  const promise = loginToShiprocket(loginEmail, loginPassword)
    .then((token) => {
      if (token) {
        const ttl = tokenLifetimeMs(token);
        if (ttl > 0) tokenCache = { key, token, expiresAt: Date.now() + ttl };
      }
      return token;
    })
    .finally(() => {
      if (inflightLogin && inflightLogin.promise === promise) inflightLogin = null;
    });
  inflightLogin = { key, promise };
  return promise;
};
// getAuthToken()

// If Shiprocket ever rejects the token we are holding (revoked, rotated), drop
// it so the very next call logs in again instead of failing until expiry. The
// failing request itself is passed through untouched.
axios.interceptors.response.use(undefined, (error) => {
  try {
    const cfg = error?.config;
    if (
      error?.response?.status === 401 &&
      tokenCache.token &&
      typeof cfg?.url === "string" &&
      cfg.url.startsWith(BASE_URL) &&
      !cfg.url.includes("/auth/login")
    ) {
      const sent = typeof cfg.headers?.get === "function" ? cfg.headers.get("Authorization") : cfg.headers?.Authorization;
      if (sent === `Bearer ${tokenCache.token}`) resetShiprocketTokenCache();
    }
  } catch (e) {
    // never let bookkeeping interfere with the original error
  }
  return Promise.reject(error);
});

const saveShipRocket = async (req, res) => {
  const { username: email, password } = req.body.credentials;
  const { courierName, courierProvider, CODDays, status } = req.body;

  if (!email || !password) return res.status(400).json({ message: "Email and password are required." });

  try {
    const response = await axios.post(
      `${BASE_URL}/auth/login`,
      { email, password },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    // console.log("shiprocket authentication",response.data)
    if (!response.data?.token) return res.status(401).json({ message: "Invalid ShipRocket credentials." });
  } catch (error) {
    // console.log("shiprocket authentication",error.response?.data)
    return res.status(400).json({
      message: "ShipRocket authentication failed.",
      error: error.response?.data?.message || error.message,
    });
  }

  try {
    const newCourier = new AllCourier({
      courierName,
      courierProvider,
      CODDays,
      status,
      email,
      password,
    });
    await newCourier.save();
    resetShiprocketTokenCache();
    return res.status(201).json({
      message: "ShipRocket courier successfully added.",
      courier: newCourier,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to save ShipRocket courier.",
      error: error.message,
    });
  }
};

module.exports = { saveShipRocket, getAuthToken, resetShiprocketTokenCache };
