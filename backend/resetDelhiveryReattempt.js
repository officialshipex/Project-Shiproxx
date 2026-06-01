
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
require("dotenv").config();

async function main() {
  console.log("Connecting to database...");
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 60000,
  });
  console.log("✅ Database connected");

  const col = mongoose.connection.db.collection("neworders");

  // Count BEFORE
  const before = await col.countDocuments({
    provider: "Delhivery",
    status: "Undelivered",
    reattempt: true,
  });
  console.log(`\nDelhivery Undelivered orders with reattempt=true (BEFORE): ${before}`);

  if (before === 0) {
    console.log("✅ Nothing to update.");
    await mongoose.disconnect();
    return;
  }

  // Update
  const result = await col.updateMany(
    { provider: "Delhivery", status: "Undelivered", reattempt: true },
    { $set: { reattempt: false } }
  );

  console.log(`\n✅ Update complete:`);
  console.log(`   Matched  : ${result.matchedCount}`);
  console.log(`   Modified : ${result.modifiedCount}`);

  // Verify AFTER
  const after = await col.countDocuments({
    provider: "Delhivery",
    status: "Undelivered",
    reattempt: true,
  });
  console.log(`\nDelhivery Undelivered orders with reattempt=true (AFTER): ${after}`);
  if (after === 0) {
    console.log("✅ Verified: All reattempt flags reset to false.");
  } else {
    console.log(`⚠️  ${after} orders still have reattempt=true!`);
  }

  await mongoose.disconnect();
  console.log("Database disconnected.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
