// Guaranteed floor for the 14 providers this system already dispatches to.
// Several of them (BoxdLogistics in particular, which authenticates via a
// static .env token rather than a stored AllCourier account) work today with
// NO AllCourier document at all — so relying purely on the database for these
// would silently drop them from dispatch. These ids stay hardcoded
// permanently. Confirmed against live data via scripts/auditProviderNames.js
// (2026-09-04).
//
// No dependencies (in particular, does NOT require models/AllCourierSchema)
// so both the schema's pre-validate hook and utils/providerIdRegistry.js can
// import this without a circular require.
const LEGACY_PROVIDER_MAP = {
  // Kept even though bookOrder.controller.js's switch has no case for it yet
  // (returns "not implemented" there) — availableCourierService.controller.js
  // does show live EcomExpress serviceability quotes today, and dropping the
  // id here would silently remove those quotes.
  "01": "EcomExpress",
  "02": "Delhivery",
  "03": "Dtdc",
  "04": "Smartship",
  "05": "Amazon Shipping",
  "06": "Shree Maruti",
  "07": "ZipyPost",
  "08": "Ekart",
  "09": "BoxdLogistics",
  "10": "Proship",
  "11": "Shiprocket",
  "12": "Shadowfax",
  "13": "Losung360",
  "14": "ShipexIndia",
  "15": "Jiffy",
};

module.exports = { LEGACY_PROVIDER_MAP };
