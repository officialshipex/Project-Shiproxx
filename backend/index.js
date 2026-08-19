require("dotenv").config();
const connection = require("./config/database");
const app = require("./server");
const { warmPool } = require("./AllCouriers/Delhivery/Authorize/waybillPool");
const { getZone } = require("./Rate/zoneManagementController");
const { reconcileStuckBulkShipJobs } = require("./Orders/bulkShipJob.controller");

const PORT = process.env.PORT || 5000;

(async function () {
  try {
    await connection();

    // Recover any bulk-ship jobs left "running" by a previous crash/restart
    // so their orders don't stay stuck invisibly and the tray doesn't poll forever.
    await reconcileStuckBulkShipJobs().catch((err) =>
      console.error("❌ Failed to reconcile stuck bulk-ship jobs:", err.message)
    );

    // Warm up the Delhivery Waybill pool in the background on startup
    warmPool().catch((err) => console.error("❌ Failed to warm Delhivery waybill pool:", err.message));

    // Pre-warm the pincodes CSV parser on startup
    getZone("110001", "110001").catch((err) => console.error("❌ Failed to pre-warm pincodes:", err.message));

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on http://65.1.105.160:${PORT}`);
    });
    server.timeout = 120000;
  } catch (err) {
    console.error("❌ Database connection error:", err);
  }
})();