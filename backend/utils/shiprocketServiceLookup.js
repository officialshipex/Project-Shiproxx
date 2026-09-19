const CourierService = require("../models/CourierService.Schema");

// Rate-card / UI service names are maintained separately from
// CourierService.name and drift in case and spacing (e.g. "DELJF 500" vs
// "DelJF 500", "SFX  premium 500" vs "SFX premium 500"). An exact-match
// lookup that misses used to leave the Shiprocket courier_id unresolved, so
// the booking went out without one and Shiprocket auto-assigned an arbitrary
// courier. Shiprocket has only a few dozen services, so match on a
// case/whitespace-normalized key in memory instead of a database regex.
const normalizeServiceName = (s) =>
  String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

const findShiprocketService = async (name) => {
  const target = normalizeServiceName(name);
  if (!target) return null;
  const services = await CourierService.find({ provider: "Shiprocket" }).lean();
  return services.find((s) => normalizeServiceName(s.name) === target) || null;
};

module.exports = { findShiprocketService, normalizeServiceName };
