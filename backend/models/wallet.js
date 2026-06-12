const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    channelOrderId: { type: String },
    category: { type: String, enum: ["credit", "debit"], required: true },
    amount: { type: Number, required: true },
    balanceAfterTransaction: { type: Number },
    date: { type: Date, default: Date.now },
    awb_number: { type: String },
    description: { type: String },
    priceBreakup: { type: Object },
  },
  { timestamps: true }
);

// Wallet history schema (only payment details)
const walletHistorySchema = new mongoose.Schema(
  {
    paymentDetails: {
      paymentId: { type: String },
      orderId: { type: String },
      signature: { type: String },
      description: { type: String },
      walletId: { type: mongoose.Schema.Types.ObjectId, ref: "Wallet" }, // 👈 Added walletId properly
      amount: { type: Number }, // 👈 Added amount properly
      transactionId: { type: String },
    },
    status: { type: String, enum: ["success", "failed"], default: "success" },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const walletSchema = new mongoose.Schema(
  {
    balance: { type: Number, default: 0 },
    creditBalance: { type: Number, default: 0 },
    creditLimit: { type: Number, default: 0 },
    holdAmount: { type: Number, default: 0 },
    notificationTransactions: [transactionSchema], // 👈 Isolated history for notifications
    walletHistory: [walletHistorySchema], // Only payment details
  },
  { timestamps: true }
);

walletSchema.virtual("currentBalance").get(function () {
  return this.balance;
});

const Wallet = mongoose.model("Wallet", walletSchema);

module.exports = Wallet;
