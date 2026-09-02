
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
require("dotenv").config();

// Read-only diagnostic for "BoxdLogistics tracking not updating". Checks,
// in order:
//   1) Would the hourly tracking cron even be scheduled in this process
//      (Orders/tracking.controller.js only calls cron.schedule when
//      NODE_ENV === "production")?
//   2) Is BOXDLOGISTICS_TOKEN actually set?
//   3) For real BoxdLogistics orders that are overdue for a tracking check
//      (same selection logic trackOrders() uses), call
//      trackOrderBoxdLogistics(awb_number) directly and print the raw
//      result — this bypasses the cron/scheduler entirely and shows
//      exactly what BoxdLogistics's tracking API actually returns right
//      now for real AWBs.
//
// Usage: node diagnoseBoxdTracking.js [limit]  (limit defaults to 5)

async function main() {
  const limitArg = parseInt(process.argv[2]) || 5;

  console.log("[1] NODE_ENV =", JSON.stringify(process.env.NODE_ENV));
  console.log("    Cron in tracking.controller.js only schedules when NODE_ENV === \"production\".");
  console.log("    ->", process.env.NODE_ENV === "production"
    ? "Cron WOULD be scheduled in this exact process."
    : "Cron would NOT be scheduled in this exact process (this only tells you about THIS process — check what NODE_ENV the actual running server has).");

  console.log("\n[2] BOXDLOGISTICS_TOKEN set?", !!process.env.BOXDLOGISTICS_TOKEN,
    process.env.BOXDLOGISTICS_TOKEN ? `(length ${process.env.BOXDLOGISTICS_TOKEN.length})` : "");

  console.log("\nConnecting to database...");
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 60000,
  });
  console.log("Database connected");

  const db = mongoose.connection.db;
  const now = new Date();
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  // Same shape as trackOrders()'s non-webhook query, narrowed to BoxdLogistics.
  const query = {
    partner: "BoxdLogistics",
    status: { $nin: ["new", "Cancelled", "Delivered", "RTO Delivered"] },
    $or: [
      { lastTrackedAt: { $exists: false } },
      { lastTrackedAt: null },
      { $and: [{ status: "Out for Delivery" }, { lastTrackedAt: { $lt: twoHoursAgo } }] },
      { $and: [{ status: { $ne: "Out for Delivery" } }, { lastTrackedAt: { $lt: threeHoursAgo } }] },
    ],
  };

  const dueOrders = await db.collection("neworders").find(query).limit(limitArg).toArray();
  console.log(`\n[3] BoxdLogistics orders currently due for a tracking check: querying with limit ${limitArg}`);
  console.log(`    Found ${dueOrders.length}.`);

  if (dueOrders.length === 0) {
    console.log("    None found — either nothing is overdue right now (all recently tracked / all terminal status),");
    console.log("    or there simply are no active BoxdLogistics orders. Try again without the status/lastTrackedAt");
    console.log("    filter if you want to test a specific AWB regardless of due-ness.");
  }

  // Load the real tracking function from the actual controller — not a
  // reimplementation — so this exercises the exact same code path production uses.
  const { trackOrderBoxdLogistics } = require("./AllCouriers/BoxdLogistics/Courier/couriers.controller");

  for (const order of dueOrders) {
    console.log(`\n--- Order ${order.orderId}  awb=${order.awb_number}  status=${order.status}  lastTrackedAt=${order.lastTrackedAt} ---`);
    try {
      const result = await trackOrderBoxdLogistics(order.awb_number);
      console.log("    result.success =", result?.success);
      if (result?.success) {
        console.log("    scan count:", Array.isArray(result.data) ? result.data.length : "N/A (not an array)");
        console.log("    latest scan:", JSON.stringify(result.data?.[result.data.length - 1]));
      } else {
        console.log("    error:", JSON.stringify(result?.error || result));
      }
    } catch (err) {
      console.log("    THREW:", err.message);
    }
  }

  console.log("\nDone.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
