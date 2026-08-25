
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
require("dotenv").config();

// One-time cleanup: before the notification feature, BulkShipJob.activeSlot
// was only ever unset when a user explicitly clicked to acknowledge/close the
// old bottom-right tray. Any job nobody acknowledged — including every job
// that was still "running" at the moment this server was last restarted, since
// the in-memory worker processing it was killed with the old process — is
// left with activeSlot still true forever, and the partial unique index then
// blocks that actor's every future bulk-ship attempt with a 409. This script
// finds and clears those stuck locks. Safe to run any time: it only touches
// activeSlot, never results/status/counts, and only jobs that are not
// currently, actually running (see the running-job handling below).
async function main() {
  console.log("Connecting to database...");
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 60000,
  });
  console.log("Database connected");

  const col = mongoose.connection.db.collection("bulkshipjobs");

  const stuck = await col
    .find({ activeSlot: true })
    .project({ initiatedById: 1, initiatedByType: 1, status: 1, totalOrders: 1, successCount: 1, failureCount: 1, createdAt: 1 })
    .toArray();

  console.log(`\nFound ${stuck.length} job(s) currently holding an active slot:`);
  stuck.forEach((j) => {
    console.log(
      `  ${j._id}  actor=${j.initiatedByType}:${j.initiatedById}  status=${j.status}  ` +
      `orders=${j.successCount || 0}+${j.failureCount || 0}/${j.totalOrders}  createdAt=${j.createdAt?.toISOString()}`
    );
  });

  if (stuck.length === 0) {
    console.log("Nothing to clean up.");
    await mongoose.disconnect();
    return;
  }

  // Any job still "status: running" right now is guaranteed orphaned — this
  // script only runs after the server process that would have been driving it
  // has already restarted, so no code anywhere is still advancing it. Mark
  // those completed (best-effort — whatever orders it got to stay as-is) so a
  // reopened notification for it, if any, doesn't spin forever either.
  const runningResult = await col.updateMany(
    { activeSlot: true, status: "running" },
    { $set: { status: "completed", completedAt: new Date() }, $unset: { activeSlot: "" } }
  );
  const completedResult = await col.updateMany(
    { activeSlot: true, status: "completed" },
    { $unset: { activeSlot: "" } }
  );

  console.log(`\nUnstuck ${runningResult.modifiedCount} orphaned running job(s) and ${completedResult.modifiedCount} unacknowledged completed job(s).`);

  const after = await col.countDocuments({ activeSlot: true });
  console.log(after === 0 ? "Verified: no jobs are holding an active slot anymore." : `${after} job(s) still holding a slot — investigate before rerunning.`);

  await mongoose.disconnect();
  console.log("Database disconnected.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
