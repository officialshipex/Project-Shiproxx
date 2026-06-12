const rateLimit = require("express-rate-limit");

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 180, // Limit each IP to 180 requests per minute
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after a minute.",
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

module.exports = apiLimiter;
