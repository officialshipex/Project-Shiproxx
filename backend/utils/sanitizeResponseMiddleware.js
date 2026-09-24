const { sanitizeClientPayload } = require("./sanitizeClientMessage");

// Mounted on the seller-facing "Ship Now" routes only (see each
// AllCouriersRoutes/*.router.js), not globally — admin-facing routes are
// expected to show the real aggregator name (courier setup, ops screens).
//
// Transparently scrubs whatever JSON body the route handler sends: the
// handler code is unchanged (still just `res.json(result)`), this just
// intercepts res.json for the duration of the request and runs the body
// through sanitizeClientPayload first. Covers every courier's "Ship Now"
// handler from one place instead of editing each one's internals.
const sanitizeJsonResponses = (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(sanitizeClientPayload(body));
  next();
};

module.exports = { sanitizeJsonResponses };
