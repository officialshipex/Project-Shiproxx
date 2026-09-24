// Every courier-facing error message in this codebase was written assuming
// only we'd ever read it — many literally say "Shiprocket"/"Jiffy"/etc, which
// leaked our internal aggregator identity straight into a seller-facing
// toast (e.g. "Failed to assign AWB. Shiprocket order created but AWB
// assignment is pending/failed."). Rewriting every such string by hand across
// ~15 courier integrations would be easy to miss one on, and says nothing
// about aggregator error text we pass through verbatim (Shiprocket's own API
// messages, for instance, are outside our control and could say anything).
// This is the safety net: applied at the small number of places a booking
// result becomes an HTTP response to a seller, it scrubs any mention of an
// aggregator platform, leaving genuine courier brand names (Delhivery,
// Shadowfax, Xpressbees, ...) untouched — those are the real carrier and
// already shown to sellers elsewhere (tracking, order list).
//
// NOT applied to admin-only routes (courier setup, admin order/ops screens) —
// admins are expected to see and need the real aggregator name.
const AGGREGATOR_NAMES = [
  "Shiprocket", // also covers "ShipRocket" (case-insensitive match below)
  "Jiffy",
  "ShipMaxx",
  "Losung360",
  "Losung 360",
  "BoxdLogistics",
  "Boxd Logistics",
  "ShipexIndia",
  "ShipxIndia",
  "Shipex India",
  "Proship",
  "NimbusPost",
  "Nimbus Post",
  "SmartShip", // also covers "Smartship"
  "Smart Ship",
  "ZipyPost", // also covers "Zipypost"
  "Zipy Post",
  "Vamaship",
  "VamaShip",
  "Vama Ship",
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest-first: a shorter alternative earlier in the list (e.g. "Vamaship")
// must never win over a longer one that contains it, though none currently
// overlap — kept as a general safety property of this list.
const NAME_PATTERN = new RegExp(
  `\\b(?:${[...AGGREGATOR_NAMES].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})\\b`,
  "gi"
);

const REPLACEMENT = "our courier partner";

// Scrubs aggregator names from a single string. Non-strings (including
// null/undefined) pass through unchanged so callers can use this on fields
// that aren't always strings without extra guards.
const sanitizeClientMessage = (text) => {
  if (typeof text !== "string" || !text) return text;
  return text.replace(NAME_PATTERN, REPLACEMENT);
};

// Deep-scrubs every string value in a JSON-shaped value (object/array/
// primitive) — for wrapping a whole response body in one call rather than
// hunting down each individual message/error field by name. Returns a new
// value; the input is not mutated.
const isPlainObject = (value) => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const sanitizeClientPayload = (value) => {
  if (typeof value === "string") return sanitizeClientMessage(value);
  if (Array.isArray(value)) return value.map(sanitizeClientPayload);
  // Only recurse into plain object literals. A Date, ObjectId, Buffer, or any
  // class instance is passed through as-is — walking those via
  // Object.entries() finds no own enumerable props and silently replaces
  // them with `{}`, corrupting e.g. any date field in the payload.
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeClientPayload(v);
    return out;
  }
  return value;
};

module.exports = { sanitizeClientMessage, sanitizeClientPayload, AGGREGATOR_NAMES };
