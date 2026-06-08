const mongoose = require("mongoose");

const misReportSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    reportType: {
      type: String,
      enum: ["All", "Delivered", "RTO", "Canceled", "Pending Order"],
      required: true
    },
    dateFilterType: {
      type: String,
      enum: ["Pickup Date", "AWB Assigned Date"],
      required: true
    },
    fromDate: {
      type: Date,
      required: true
    },
    toDate: {
      type: Date,
      required: true
    },
    email: {
      type: String,
      default: ""
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending"
    },
    downloadUrl: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("MisReport", misReportSchema);
