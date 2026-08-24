const mongoose = require("mongoose");
const dns = require("dns");

// Some mobile carrier / hotspot DNS resolvers don't properly support SRV
// record lookups, which mongodb+srv:// connection strings depend on to find
// the cluster (fails as `querySrv ECONNREFUSED ...mongodb.net`). Point
// Node's resolver at public DNS servers that do support it. Only applied
// outside production so the deployed server's DNS behavior is unaffected.
if (process.env.NODE_ENV !== "production") {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}

async function connectDB() {
  try {
    // console.log("hii")
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 60000,
      maxPoolSize: 10,
      connectTimeoutMS: 10000,
    });

    console.log("✅ Database connected successfully");

    // ── Warm the Delhivery waybill pool on startup ──────────────────────────
    // This pre-fetches 50 waybills per account so the first booking request
    // pops from cache (~2ms) instead of making a live Delhivery API call (~2s).
    // Runs in background — does NOT block server startup.
    if (process.env.NODE_ENV === "production") {
      setImmediate(async () => {
        try {
          const { warmPool } = require("../AllCouriers/Delhivery/Authorize/waybillPool");
          const { getDelhiveryApiKey } = require("../AllCouriers/Delhivery/Authorize/saveCourierContoller");
          const AllCourier = require("../models/AllCourierSchema");

          // Warm pool for every active Delhivery account
          const delhiveryAccounts = await AllCourier.find({
            courierProvider: "Delhivery",
            status: "active",
          }).lean().select("apiKey courierName");

          if (delhiveryAccounts.length === 0) {
            // Fallback: warm with default API key
            const defaultKey = await getDelhiveryApiKey(null);
            await warmPool(defaultKey);
          } else {
            await Promise.all(delhiveryAccounts.map((acc) => warmPool(acc.apiKey)));
          }

          console.log(`✅ [WaybillPool] Warmed ${delhiveryAccounts.length || 1} Delhivery account(s) on startup.`);
        } catch (poolErr) {
          console.error("⚠️ [WaybillPool] Startup warm failed (non-critical):", poolErr.message);
        }
      });
    }
  } catch (err) {
    console.error("❌ Database connection error:", err);
    process.exit(1); // Exit if initial DB connection fails
  }
}

module.exports = connectDB;

