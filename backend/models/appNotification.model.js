const mongoose = require("mongoose");

// In-app notification pointer for long-running/background actions (Bulk Ship,
// Bulk Order Upload). Deliberately minimal — no duplicated status/counts, no
// `type` field (redundant with refModel: BulkShipJob -> "Bulk Ship",
// BulkOrderFiles -> "Bulk Upload"). Always read live via refPath population
// so there's exactly one source of truth per underlying job/file.
const appNotificationSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
  actorType: { type: String, enum: ["user", "employee"], required: true },
  refModel: { type: String, enum: ["BulkShipJob", "BulkOrderFiles"], required: true },
  refId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "refModel" },
  // Static info that can't be cheaply derived live at read time, e.g.
  // "Bulk Ship — 42 orders" / "Bulk Order Upload (B2B) — 120 rows".
  title: { type: String, required: true },
  dismissed: { type: Boolean, default: false },
}, { timestamps: true });

appNotificationSchema.index({ actorId: 1, actorType: 1, dismissed: 1, createdAt: -1 });
appNotificationSchema.index({ actorId: 1, actorType: 1, refModel: 1, createdAt: -1 });

module.exports = mongoose.model("AppNotification", appNotificationSchema);
