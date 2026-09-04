const AllCourier = require("../models/AllCourierSchema");
const { LEGACY_PROVIDER_MAP } = require("./legacyProviderMap");

// id -> provider name, e.g. { "02": "Delhivery", ..., "16": "SomeNewProvider" }
const getProviderMap = async () => {
  const rows = await AllCourier.find({ courierId: { $exists: true, $ne: null } })
    .select("courierId courierName")
    .lean();
  const dbMap = Object.fromEntries(rows.map((r) => [r.courierId, r.courierName]));
  // Legacy always wins a collision — it's the proven-correct value.
  return { ...dbMap, ...LEGACY_PROVIDER_MAP };
};

// provider name -> id, e.g. { "Delhivery": "02", ..., "SomeNewProvider": "16" }
// When a provider has multiple AllCourier accounts (multiple ids), the lowest
// id wins — deterministic, and matches the single-id-per-provider assumption
// external API callers already depend on.
const getReverseProviderMap = async () => {
  const rows = await AllCourier.find({ courierId: { $exists: true, $ne: null } })
    .select("courierId courierName")
    .sort({ courierId: 1 })
    .lean();
  const dbReverseMap = {};
  for (const r of rows) {
    if (!(r.courierName in dbReverseMap)) {
      dbReverseMap[r.courierName] = r.courierId;
    }
  }
  const legacyReverseMap = Object.fromEntries(
    Object.entries(LEGACY_PROVIDER_MAP).map(([id, name]) => [name, id])
  );
  return { ...dbReverseMap, ...legacyReverseMap };
};

module.exports = { getProviderMap, getReverseProviderMap, LEGACY_PROVIDER_MAP };
