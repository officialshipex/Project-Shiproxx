const mongoose = require("mongoose");

const codPlanSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    // required: true,
  },
  planName: {
    type: String,
    enum: ["D+1", "D+2", "D+3", "D+4", "D+5", "D+6", "D+7"],
    default: "D+7",
    required: true,
  },
  planCharges: {
    type: Number,
  },
  isCustom: {
    type: Boolean,
    default: false,
  },
  remittanceDay: {
    type: [String],
  },
});

codPlanSchema.pre("save", function (next) {
  if (this.isCustom) return next();
  const planChargesMap = {
    "D+1": 1.5,
    "D+2": 0.99,
    "D+3": 0.69,
    "D+4": 0.49,
    "D+5": 0,
    "D+6": 0,
    "D+7": 0,
  };
  this.planCharges = planChargesMap[this.planName] ?? 0;
  next();
});

const CodPlan = mongoose.models.CodPlan || mongoose.model("CodPlan", codPlanSchema);

module.exports = CodPlan;
