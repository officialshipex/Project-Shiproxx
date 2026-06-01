const mongoose = require("mongoose");

const userAgreementSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    agreement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agreement",
      required: true,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    isAccepted: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
    },
    acceptedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

userAgreementSchema.index({ user: 1, agreement: 1 }, { unique: true });

const UserAgreement = mongoose.model("UserAgreement", userAgreementSchema);

module.exports = UserAgreement;
