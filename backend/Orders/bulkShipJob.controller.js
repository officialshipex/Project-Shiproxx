const BulkShipJob = require("../models/bulkShipJob.model");
const Order = require("../models/newOrder.model");

// Resolves the acting identity (customer/seller vs staff/admin) from the
// isAuthorized middleware's req.user / req.employee, whichever is set.
const getActor = (req) => {
  if (req.employee) return { id: req.employee._id, type: "employee" };
  if (req.user) return { id: req.user._id, type: "user" };
  return { id: null, type: null };
};

const getActiveBulkShipJob = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const job = await BulkShipJob.findOne({
      initiatedById: actor.id,
      initiatedByType: actor.type,
      activeSlot: true,
    }).select("-results");

    return res.status(200).json({ success: true, job: job || null });
  } catch (error) {
    console.error("getActiveBulkShipJob error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const getBulkShipStatus = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { jobId } = req.params;
    const detail = req.query.detail === "true";

    const query = BulkShipJob.findById(jobId);
    if (!detail) query.select("-results");

    const job = await query;
    if (!job || String(job.initiatedById) !== String(actor.id) || job.initiatedByType !== actor.type) {
      return res.status(404).json({ success: false, message: "Bulk ship job not found" });
    }

    return res.status(200).json({ success: true, job });
  } catch (error) {
    console.error("getBulkShipStatus error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const acknowledgeBulkShipJob = async (req, res) => {
  try {
    const actor = getActor(req);
    if (!actor.id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { jobId } = req.params;
    const job = await BulkShipJob.findOneAndUpdate(
      {
        _id: jobId,
        initiatedById: actor.id,
        initiatedByType: actor.type,
        status: "completed",
      },
      { $set: { acknowledged: true }, $unset: { activeSlot: "" } },
      { new: true }
    ).select("-results");

    if (!job) {
      return res.status(404).json({ success: false, message: "Bulk ship job not found or not yet completed" });
    }

    return res.status(200).json({ success: true, job });
  } catch (error) {
    console.error("acknowledgeBulkShipJob error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

// Called once at server boot. Recovers any job left "running" by a server
// crash/restart so it doesn't poll forever on the client and doesn't leave
// its orders stuck invisibly at status:"processing".
const reconcileStuckBulkShipJobs = async () => {
  const stuckJobs = await BulkShipJob.find({ status: "running" });
  if (stuckJobs.length === 0) return;

  console.log(`Reconciling ${stuckJobs.length} bulk-ship job(s) left running by a previous process...`);

  for (const job of stuckJobs) {
    const stuckOrderIds = [];
    let recoveredFailures = 0;

    job.results.forEach((result) => {
      if (result.status === "pending" || result.status === "processing") {
        stuckOrderIds.push(result.orderId);
        result.status = "failed";
        result.failureReason = "Processing was interrupted by a server restart. Please retry.";
        result.completedAt = new Date();
        recoveredFailures++;
      }
    });

    if (stuckOrderIds.length > 0) {
      await Order.updateMany(
        { _id: { $in: stuckOrderIds }, status: "processing" },
        { $set: { status: "new" } }
      );
    }

    job.failureCount = (job.failureCount || 0) + recoveredFailures;
    job.status = "completed";
    job.completedAt = new Date();
    await job.save();
  }
};

module.exports = {
  getActor,
  getActiveBulkShipJob,
  getBulkShipStatus,
  acknowledgeBulkShipJob,
  reconcileStuckBulkShipJobs,
};
