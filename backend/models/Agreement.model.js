const mongoose = require("mongoose");

const agreementSchema = new mongoose.Schema(
  {
    fileName: {
      type: String,
      required: true,
    },
    versionName: {
      type: String,
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

const Agreement = mongoose.model("Agreement", agreementSchema);

module.exports = Agreement;
