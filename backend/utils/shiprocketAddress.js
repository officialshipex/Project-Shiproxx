// Shiprocket refuses an order whose address is too long, and it checks twice:
//   - 422 "may not be greater than 190 characters" — 190 per address line
//   - 400 "Address 1 and Address 2 combined cannot be greater 190 than
//     characters" — 190 for line 1 + line 2 *together*
// The second rule means spilling the overflow into address_2 buys nothing, so
// the whole address has to fit in 190 characters in total.
//
// Only an address that is actually over the limit is touched — anything that
// fits goes out byte-for-byte as before. For one that doesn't, shed what
// carries the least delivery information first and stop the moment it fits:
//   1. whitespace runs (checkout forms leave \r\n and blank lines behind)
//   2. trailing "City : x" / "State : y" / "Pincode : z" form fields — the
//      same values are already sent as shipping_city / _state / _pincode
//   3. trailing bare city / state / pincode / "India" repeating those fields
//   4. last resort: cut at the last word boundary that fits (the tail of the
//      address is lost, but the booking goes through)
const SHIPROCKET_ADDRESS_MAX = 190;

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A labelled form field at the very end, e.g. "City : ahemdabad". The value is
// capped at 40 characters and may not contain a comma or colon, so a label that
// happens to sit inside real address text ("Green City : phase 2, plot 9 ...")
// is not mistaken for a trailing field.
const TRAILING_LABELLED_FIELD =
  /[\s,;|-]*\b(?:city|town|district|dist|state|pin\s*code|pincode|pin|zip|country)\s*[:=-]\s*[^:,]{0,40}$/i;

const trailingRepeatsRegExp = ({ city, state, pincode }) => {
  const values = [pincode, state, city, "India"]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .map(escapeRegExp);
  // (?<![A-Za-z0-9]) so "Delhi" is never sliced off the end of "NewDelhi".
  return new RegExp(`[\\s,;|.-]*(?<![A-Za-z0-9])(?:${values.join("|")})[\\s,;|.-]*$`, "i");
};

const fitShiprocketAddress = (raw, { city, state, pincode } = {}) => {
  const max = SHIPROCKET_ADDRESS_MAX;
  const original = String(raw ?? "");
  if (original.length <= max) return original;

  let out = original.replace(/\s+/g, " ").trim();

  const shed = (re) => {
    while (out.length > max) {
      const next = out.replace(re, "").trim();
      if (!next || next === out) break;
      out = next;
    }
  };
  shed(TRAILING_LABELLED_FIELD);
  shed(trailingRepeatsRegExp({ city, state, pincode }));
  if (out.length <= max) return out;

  const cut = out.lastIndexOf(" ", max);
  return out.slice(0, cut > max / 2 ? cut : max).replace(/[\s,;:.|-]+$/, "");
};

module.exports = { fitShiprocketAddress, SHIPROCKET_ADDRESS_MAX };
