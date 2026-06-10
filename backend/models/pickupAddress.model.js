const mongoose = require("mongoose");
// const { displayName } = require('react-quill');

const pickupAddress = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  isPrimary: { type: Boolean, default: false },
  pickupAddress: {
    contactName: { type: String, required: true },
    email: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    address: { type: String, required: true },
    pinCode: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
  },
  smartshipHubId: {
    type: String,
    default: "",
  },
  zipypostHubId: {
    type: String,
    default: ""
  },
  ekartAlias: {
    type: String,
    default: ""
  },
  boxdLogisticsWarehouseId: {
    type: String,
    default: ""
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

pickupAddress.index({ userId: 1, createdAt: -1 });
pickupAddress.index({ createdAt: -1 });

const Shipment = mongoose.model("pickupAddress", pickupAddress);

module.exports = Shipment;
