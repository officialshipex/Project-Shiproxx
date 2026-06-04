// server.js
require("dotenv").config();
const express = require("express");
const passport = require("passport");
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const compression = require("compression");

const router = require("./routes");
const ShipRocketController = require("./AllCouriersRoutes/shiprocket.router");
const ShreeMarutiController = require("./AllCouriersRoutes/shreemaruti.router");
const nimbuspostRoutes = require("./AllCouriersRoutes/nimbuspost.router");
const delhiveryRouter = require("./AllCouriersRoutes/delhivery.router");
const otpRouter = require("./auth/auth.otp");
const emailOtpRouter = require("./notification/emailOtpVerification");
const { resetPassword } = require("./notification/resetPassword");
require("./cron/ndrCron"); // Initialize NDR cron jobs

const {
  loadCourierPincodes,
} = require("./checkPincodeServiceability/checkPincodeServiceability.controller");
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
app.use(helmet());
app.use(cors());
app.use(compression());

const store = MongoStore.create({
  mongoUrl: process.env.MONGODB_URI,
  crypto: { secret: process.env.MONGO_SECRET },
  touchAfter: 24 * 3600,
});
// (async () => {
//   await loadCourierPincodes();
// })();

app.use(
  session({
    store,
    secret: process.env.MONGO_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);



app.use(passport.initialize());

// Routes
app.use("/v1", router);
app.use(
  "/v1/channel/webhook-handler",
  express.raw({ type: "application/json" })
);
app.use("/v1/Shiprocket", ShipRocketController);
app.use("/v1/shreeMaruti", ShreeMarutiController);
app.use("/v1/delhivery", delhiveryRouter);
app.use("/v1/nimbuspost", nimbuspostRoutes);
app.use("/v1/auth", otpRouter);
app.use("/v1/auth", emailOtpRouter);
app.use("/v1/auth", resetPassword);

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = app; // ✅ Export the Express app
