const mongoose = require("mongoose");
// const { courierCodRemittance } = require("./cod.controller");

const CodRemittanceOrderSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  Date: {
    type: Date,
  },
  orderID: {
    type: String,
    unique: true,
  },
  userName: {
    type: String,
  },
  PhoneNumber: {
    type: String,
  },
  Email: {
    type: String,
  },
  courierProvider: {
    type: String,
  },
  AWB_Number: {
    type: String,
  },
  CODAmount: {
    type: String,
  },
  status: {
    type: String,
    enum: ["Pending", "Paid"],
    default: "Pending",
  },
});

CodRemittanceOrderSchema.index({ userId: 1 });
CodRemittanceOrderSchema.index({ orderID: 1 }, { unique: true });
CodRemittanceOrderSchema.index({ AWB_Number: 1 });
CodRemittanceOrderSchema.index({ status: 1 });
CodRemittanceOrderSchema.index({ Date: -1 });

const CodRemittanceOrder = mongoose.model(
  "CodRemittanceOrder",
  CodRemittanceOrderSchema
);
module.exports = CodRemittanceOrder;
