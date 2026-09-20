const axios = require("axios");

// Every Shiprocket booking used to fetch the account's whole pickup-location
// list (single ship) or re-register the same pickup address (bulk ship) — one
// extra round trip per order to learn something that almost never changes.
// Keep the list for a while and refetch only when we have just changed it, or
// when Shiprocket rejects an order over its pickup location.
const PICKUP_LIST_TTL_MS = 15 * 60 * 1000;

let cache = null; // { at, promise }

const pickupUrl = () => `${process.env.SHIPROCKET_URL}/v1/external/settings/company/pickup`;

// Shiprocket has returned this list under several shapes over time.
const extractLocations = (body) => {
  if (Array.isArray(body?.data?.shipping_address)) return body.data.shipping_address;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.shipping_address)) return body.shipping_address;
  return [];
};

const invalidatePickupLocations = () => {
  cache = null;
};

// Rejects with the original axios error when the fetch fails (callers rely on
// error.response?.status) and never remembers a failure.
const getPickupLocations = (token) => {
  const age = cache ? Date.now() - cache.at : -1;
  if (cache && age >= 0 && age < PICKUP_LIST_TTL_MS) return cache.promise;

  const entry = { at: Date.now() };
  entry.promise = axios
    .get(pickupUrl(), { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
    .then((response) => extractLocations(response.data));
  cache = entry;
  entry.promise.catch(() => {
    if (cache === entry) cache = null;
  });
  return entry.promise;
};

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

// Register `name` with Shiprocket only if it is not already on the account.
// `register` is the caller's existing add-pickup call, unchanged. If the list
// cannot be read we behave exactly as before and register.
const ensurePickupLocation = async (token, name, register) => {
  let known = null;
  try {
    known = await getPickupLocations(token);
  } catch (e) {
    known = null;
  }
  if (known && known.some((loc) => sameName(loc.pickup_location, name))) return;

  const created = await register();
  // Only a registration that actually succeeded changes the account's list.
  // If it failed, keep what we know: forgetting it would just cost one more
  // fetch per order for a location that still is not there.
  if (created) invalidatePickupLocations();
};

// True when a Shiprocket order-creation error is about the pickup location —
// the sign that our remembered list is out of date.
const isPickupLocationError = (errData, fallbackMessage) => {
  const text = `${errData?.message || ""} ${JSON.stringify(errData?.errors || {})} ${fallbackMessage || ""}`;
  return /pickup/i.test(text);
};

module.exports = {
  getPickupLocations,
  invalidatePickupLocations,
  ensurePickupLocation,
  isPickupLocationError,
  extractLocations,
};
