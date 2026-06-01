
// Fix: Use Google's public DNS so SRV lookup works
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const mongoose = require("mongoose");
require("dotenv").config();

const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  console.log("Connecting to database...");
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 60000,
  });
  console.log("✅ Database connected");

  const db = mongoose.connection.db;
  const col = db.collection("neworders");

  // --- Step 1: Count affected orders BEFORE update (across ALL statuses) ---
  const before = await col.countDocuments({
    "ndrHistory.actions.actionBy": "DelightCargo",
  });
  console.log(`\nOrders with DelightCargo history entries (BEFORE): ${before}`);

  if (before === 0) {
    console.log("✅ Nothing to delete. All clean.");
    await mongoose.disconnect();
    return;
  }

  // --- Step 2: Pull out all ndrHistory blocks that contain a DelightCargo action ---
  // No status filter — clean across all orders globally
  const result = await col.updateMany(
    { "ndrHistory.actions.actionBy": "DelightCargo" },
    {
      $pull: {
        ndrHistory: {
          actions: { $elemMatch: { actionBy: "DelightCargo" } },
        },
      },
    }
  );

  console.log(`\n✅ Update complete:`);
  console.log(`   Matched  : ${result.matchedCount}`);
  console.log(`   Modified : ${result.modifiedCount}`);

  // --- Step 3: Verify AFTER ---
  const after = await col.countDocuments({
    "ndrHistory.actions.actionBy": "DelightCargo",
  });
  console.log(`\nOrders with DelightCargo history entries (AFTER): ${after}`);
  if (after === 0) {
    console.log("✅ Verified: No DelightCargo entries remain.");
  } else {
    console.log(`⚠️  ${after} orders still have DelightCargo entries!`);
  }

  await mongoose.disconnect();
  console.log("Database disconnected.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
