const mongoose = require("mongoose");
// const { displayName } = require('react-quill');

const receiverAddress = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  receiverAddress: {
    contactName: { type: String, required: true },
    email: { type: String },
    phoneNumber: { type: String, required: true },
    address: { type: String, required: true },
    pinCode: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Shipment = mongoose.model("receiverAddress", receiverAddress);

module.exports = Shipment;
