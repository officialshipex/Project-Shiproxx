// Classifies the text of a Shiprocket scan (status + activity) so that a
// shipment is only marked "In-transit" after the parcel has really left the
// seller — never just because *some* scan arrived.
//
// Why: Shiprocket passes the underlying courier's raw scan text straight
// through (Delhivery "FMOFP-101 Manifested - Out for Pickup", "FMEOD-103
// Manifested - Shipper unavailable", "592-T-PU PICKUP CANCELLED BY CALL", ...)
// and `shipment_status` is null on these. The old fallback treated any scan
// it did not recognise as "forward progress", so 643 orders whose pickup had
// not happened (or had failed) were marked In-transit.
//
//   "pickup_stage" -> parcel NOT yet with the courier: stay Ready To Ship
//   "moved"        -> parcel picked up / moving: In-transit
//   "unknown"      -> do not guess: leave the status as it is
//
// Pickup-stage is checked FIRST so "Out for Pickup" can never be read as
// movement.

const PICKUP_STAGE = [
  "out for pickup",
  "out_for_pickup",
  "pickup scheduled",
  "pickup booked",
  "pickup rescheduled",
  "pickuprescheduled",
  "pickup exception",
  "pickup cancel",
  "pickup wrongly",
  "pickup pending",
  "pickup not",
  "pickup failed",
  "pickup error",
  "pickup generated",
  "shipper unavailable",
  "seller initiated delay",
  "assigned_for_seller_pickup",
  "assigned for seller pickup",
  "item new",
  "item_new",
  "item on hold",
  "pickup delay",
  "shipment booked",
  "awb assigned",
  "order placed",
];

// Raw courier pickup codes: FMOFP-101, FMEOD-103, FMPUR-*, 592-T-PU, OFP
const PICKUP_CODE = /(^|\s)(fmofp|fmeod|fmpur|fmpu|ofp)(-|\s|$)|-t-pu(\s|$)/i;

const MOVED = [
  "picked up",
  "pickup done",
  "pickup complete",
  "shipment picked",
  "in transit",
  "in-transit",
  "in_transit",
  "intransit",
  "bag added",
  "bag received",
  "bag in transit",
  "bag_received",
  "bag_in_transit",
  "added to bag",
  "item_manifested",
  "received at",
  "recd_at",
  "reached at",
  "reached destination",
  "arrived",
  "departed",
  "dispatched",
  "handed over",
  "handover",
  "hub",
  "facility",
  "origin center",
  "destination",
  "trip",
  "vehicle",
  "connection",
  "delayed",
  "misrouted",
];

const PICKED_CODE = /(^|\s)(x-ppom|x-piom|x-dll|x-ill|x-ibd|ppom|piom)/i;

const classifyShiprocketScan = (...parts) => {
  const text = parts
    .filter(Boolean)
    .map((p) => String(p))
    .join(" ")
    .toLowerCase()
    .trim();
  if (!text) return "unknown";

  if (PICKUP_STAGE.some((k) => text.includes(k)) || PICKUP_CODE.test(text)) {
    // "Shipment picked up" must win over a stray "manifested" in the same scan
    if (!/picked up|pickup done|pickup complete/.test(text)) return "pickup_stage";
  }
  if (PICKED_CODE.test(text) || MOVED.some((k) => text.includes(k))) return "moved";
  return "unknown";
};

module.exports = { classifyShiprocketScan };
