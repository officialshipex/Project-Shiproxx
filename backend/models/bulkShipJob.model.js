const mongoose = require("mongoose");

const bulkShipResultSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  displayOrderId: { type: Number, default: null },
  status: { type: String, enum: ["pending", "processing", "success", "failed"], default: "pending" },
  courierServiceName: { type: String, default: null },
  failureReason: { type: String, default: null },
  completedAt: { type: Date, default: null },
}, { _id: false });

const bulkShipJobSchema = new mongoose.Schema({
  initiatedById: { type: mongoose.Schema.Types.ObjectId, required: true },
  initiatedByType: { type: String, enum: ["user", "employee"], required: true },
  status: { type: String, enum: ["running", "completed"], default: "running" },
  totalOrders: { type: Number, required: true },
  successCount: { type: Number, default: 0 },
  failureCount: { type: Number, default: 0 },
  results: [bulkShipResultSchema],
  acknowledged: { type: Boolean, default: false },
  // present + true only while running OR completed-but-not-yet-acknowledged;
  // unset on acknowledge so the partial unique index below frees the slot.
  activeSlot: { type: Boolean },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

// Only one active (running, or completed-but-unclosed) job per actor at a time.
bulkShipJobSchema.index(
  { initiatedById: 1, initiatedByType: 1 },
  { unique: true, partialFilterExpression: { activeSlot: true } }
);

module.exports = mongoose.model("BulkShipJob", bulkShipJobSchema);
