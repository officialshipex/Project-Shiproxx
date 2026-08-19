const mongoose = require("mongoose");

const AllChannel = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  channel:{
    type:String
  },
  storeName: {
    type: String,
    // required: true,
  },
  storeURL: {
    type: String,
    // required: true,
  },
  storeClientId: {
    type: String,
    // required: true,
  },
  storeClientSecret: {
    type: String,
    // required: true,
  },
  storeAccessToken: {
    type: String,
    // required:true
  },
  orderSyncFrequency: {
    type: String,
    enum: ["daily", "weekly", "monthly"],
    default: "daily",
  },
  paymentStatus: {
    COD: {
      type: String,
      default: "",
    },
    Prepaid: {
      type: String,
      default: "",
    },
  },
  multiSeller: {
    type: Boolean,
    default: false,
  },
  syncInventory: {
    type: Boolean,
    default: false,
  },
  syncFromDate: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  webhookId:{
    type:Number
  },
  // WooCommerce webhook signing secret, captured at creation time so incoming
  // webhooks can be verified. Absent for stores connected before this field
  // existed, or for a store whose webhook already existed at connect time
  // (WooCommerce doesn't return the secret for a pre-existing webhook).
  webhookSecret: {
    type: String
  },
  lastSync:{
    type:Date
  }
});

module.exports = mongoose.model("allChannel", AllChannel);
