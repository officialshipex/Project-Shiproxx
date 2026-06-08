const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    walletId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Wallet", 
      required: true, 
      index: true 
    },
    channelOrderId: { type: String, index: true },
    category: { type: String, enum: ["credit", "debit"], required: true },
    amount: { type: Number, required: true },
    balanceAfterTransaction: { type: Number },
    date: { type: Date, default: Date.now },
    awb_number: { type: String, index: true },
    description: { type: String },
    priceBreakup: { type: Object },
    transactionStatus: { type: String, default: "Success" }
  },
  { timestamps: true }
);

walletTransactionSchema.index({ walletId: 1, date: -1 });
walletTransactionSchema.index({ date: -1 });

const WalletTransaction = mongoose.model("WalletTransaction", walletTransactionSchema);
module.exports = WalletTransaction;
