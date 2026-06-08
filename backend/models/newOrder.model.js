const mongoose = require("mongoose");

// Sub-schema for each action in NDR
const ndrActionSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    actionBy: { type: String, required: true },
    remark: { type: String },
    source: { type: String },
    date: { type: Date, default: Date.now },
  },
  { _id: false },
);

// Each entry in ndrHistory = array of max 2 actions
const ndrEntrySchema = new mongoose.Schema(
  {
    actions: {
      type: [ndrActionSchema],
      validate: {
        validator: function (arr) {
          return arr.length <= 2;
        },
        message: "Each NDR entry can contain at most 2 actions",
      },
    },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    orderId: {
      type: Number,
      required: true,
    },
    channelId: {
      type: Number,
    },
    channel: {
      type: String,
    },
    storeUrl: {
      type: String,
    },
    pickupAddress: {
      contactName: { type: String, required: true },
      email: { type: String },
      phoneNumber: { type: String, required: true },
      address: { type: String, required: true },
      pinCode: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
    },
    receiverAddress: {
      contactName: { type: String, required: true },
      email: { type: String },
      phoneNumber: { type: String, required: true },
      address: { type: String, required: true },
      pinCode: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
    },
    productDetails: [
      {
        id: { type: Number, required: true },
        quantity: { type: Number },
        name: { type: String },
        hsn: { type: String },
        sku: { type: String },
        unitPrice: { type: String },
        category: { type: String },
        discount: { type: String },
        tax: { type: String },
      },
    ],
    packageDetails: {
      deadWeight: { type: Number },
      applicableWeight: { type: Number },
      volumetricWeight: {
        length: { type: Number },
        width: { type: Number },
        height: { type: Number },
        calculatedWeight: { type: Number },
      },
    },
    B2BPackageDetails: {
      applicableWeight: { type: String },
      volumetricWeight: { type: String },
      packages: [
        {
          id: { type: Number },
          noOfBox: { type: Number },
          weightPerBox: { type: Number },
          length: { type: Number },
          width: { type: Number },
          height: { type: Number },
        },
      ],
    },
    orderType: { type: String, enum: ["B2C", "B2B"], default: "B2C" },
    rovType: {
      type: String,
      enum: ["ROV Owner", "ROV Carrier"],
      default: "ROV Owner",
    },
    lrn: { type: String },
    oid: { type: String },
    otherDetails: {
      resellerName: { type: String },
      gstin: { type: String },
      ewaybill: { type: String },
    },
    compositeOrderId: {
      type: String,
      unique: true,
    },
    zone: { type: String },

    paymentDetails: {
      method: { type: String, enum: ["COD", "Prepaid"], required: true },
      amount: { type: Number, required: true },
    },
    rateBreakup: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Updated ndrHistory
    ndrHistory: {
      type: [ndrEntrySchema],
      default: [],
    },

    ndrReason: {
      date: { type: Date },
      reason: { type: String },
    },

    awb_number: { type: String },
    child_awb_numbers: {
      type: [String],
      default: [],
    },
    priceBreakup: {
      freight: { type: Number },
      cod: { type: Number },
      gst: { type: Number },
      rto: {
        freight: { type: Number },
        gst: { type: Number },
      },
      total: { type: Number },
    },
    label: { type: String },
    manifest: { type: String },
    shipment_id: { type: String },
    provider: { type: String },
    courierName: { type: String },
    partner: { type: String },
    totalFreightCharges: { type: Number },
    status: { type: String, required: true },
    ndrStatus: { type: String },
    createdAt: { type: Date, default: Date.now },
    shipmentCreatedAt: { type: Date },
    courierServiceName: { type: String },
    RTOCharges: { type: String },
    COD: { type: String },
    reattempt: { type: Boolean, default: false },
    commodityId: { type: Number },
    estimatedDeliveryDate: { type: Date },
    walletDeducted: { type: Boolean, default: false },
    walletRefunded: { type: Boolean, default: false },
    manifestJobId: { type: String },
    invoiceDate: { type: Date },//exact pickup date
    pickupDate: { type: Date },//estimated pickup date
    pickupId: { type: String, default: null },  // auto-assigned pickup manifest ID
    lastTrackedAt: { type: Date }, // 🕒 Tracks the last time polling occurred

    tracking: [
      {
        status: { type: String },
        StatusLocation: { type: String },
        StatusDateTime: { type: Date },
        Instructions: { type: String },
      },
    ],
    codProcessed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Compound index
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ userId: 1, updatedAt: -1 });
orderSchema.index({ userId: 1, "ndrReason.date": -1, createdAt: -1 });
orderSchema.index({ userId: 1, invoiceDate: -1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ invoiceDate: -1 });
orderSchema.index({ shipmentCreatedAt: -1 });
orderSchema.index({ "ndrReason.date": -1, createdAt: -1 });
// ✅ PERF FIX: Index for direct orderId lookups (bookOrder API, tracking, etc.)
orderSchema.index({ orderId: 1 });
// ✅ PERF FIX: Index for AWB-based lookups (tracking, webhooks, etc.)
orderSchema.index({ awb_number: 1 });

// ── Auto NDR AI Calling Trigger & LastTrackedAt Update ──────────────────
orderSchema.pre("save", function (next) {
  // Always update lastTrackedAt when saving an order (fresh poll or webhook)
  this.lastTrackedAt = new Date();

  // Check if order became eligible for AI NDR calling (Undelivered + Reattempt)
  if (this.ndrStatus === "Undelivered" && this.reattempt === true) {
    if (this.isModified("ndrStatus") || this.isModified("reattempt")) {
      this._shouldAutoCallAiNdr = true;
    }
  }
  // Check if status changed
  if (this.isModified("status")) {
    this._shouldTriggerStatusNotification = true;
  }
  // Check if tracking array grew (new entry added)
  if (this.isModified("tracking")) {
    this._shouldTriggerTrackWebhook = true;
  }
  next();
});

// ── Auto Update lastTrackedAt for direct updates ─────────────────────────
orderSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function (next) {
  const update = this.getUpdate();
  // Ensure lastTrackedAt is updated on any change, especially status updates
  if (!update.$set) update.$set = {};
  update.$set.lastTrackedAt = new Date();
  next();
});

orderSchema.post("save", async function (doc) {
  if (doc._shouldAutoCallAiNdr) {
    try {
      const { autoTriggerNdrAiCall } = require("../aiCalling/autoNdrAiCall");
      autoTriggerNdrAiCall(doc, doc.ndrStatus);
    } catch (err) {
      console.error("AI NDR Hook error:", err);
    }
  }

  if (doc._shouldTriggerStatusNotification) {
    try {
      const { triggerStatusNotification } = require("../utils/statusNotification");
      triggerStatusNotification(doc);

      if (doc.status === "RTO Delivered") {
        const { rtoCharges } = require("../RTO/rtoController");
        rtoCharges(doc._id);
      }
    } catch (err) {
      console.error("Status Notification/RTO Hook error:", err);
    }
  }

  // 🔔 Dispatch track_update webhook when tracking is modified
  if (doc._shouldTriggerTrackWebhook) {
    try {
      const { dispatchTrackWebhook } = require("../utils/dispatchTrackWebhook");
      const latestTracking = Array.isArray(doc.tracking) && doc.tracking.length > 0
        ? doc.tracking[doc.tracking.length - 1]
        : null;
      dispatchTrackWebhook(doc.toObject(), latestTracking);
    } catch (err) {
      console.error("Track Webhook Hook error:", err);
    }
  }
});

// ── Centralized Trigger for findByIdAndUpdate / findOneAndUpdate ──────────
orderSchema.post("findOneAndUpdate", async function (doc) {
  try {
    const update = this.getUpdate();
    const status = update.$set?.status || update.status;

    // If status is being updated, trigger notification
    if (status) {
      const { triggerStatusNotification } = require("../utils/statusNotification");

      const notificationDoc = doc ? (doc.toObject ? doc.toObject() : doc) : {};
      if (update.$set) Object.assign(notificationDoc, update.$set);
      else if (update.status) Object.assign(notificationDoc, { status: update.status });

      if (notificationDoc.status && notificationDoc.userId) {
        triggerStatusNotification(notificationDoc);
      }

      // 🚚 Trigger RTO charges processing in real-time
      if (notificationDoc.status === "RTO Delivered") {
        try {
          const { rtoCharges } = require("../RTO/rtoController");
          rtoCharges(notificationDoc._id);
        } catch (err) {
          console.error("Real-time RTO Charge processing error:", err);
        }
      }

      // 🤖 Trigger AI NDR call in real-time
      const ndrStatus = update.$set?.ndrStatus || update.ndrStatus;
      const reattempt = update.$set?.reattempt || update.reattempt;

      if (ndrStatus || reattempt !== undefined) {
        const finalNdrStatus = ndrStatus || doc.ndrStatus;
        const finalReattempt = reattempt !== undefined ? reattempt : doc.reattempt;

        if (finalNdrStatus === "Undelivered" && finalReattempt === true) {
          try {
            const { autoTriggerNdrAiCall } = require("../aiCalling/autoNdrAiCall");
            autoTriggerNdrAiCall(doc, finalNdrStatus);
          } catch (err) {
            console.error("Real-time AI NDR trigger error:", err);
          }
        }
      }
    }

    // 🔔 Dispatch track_update webhook when $push.tracking is used
    const pushedTracking = update.$push?.tracking;
    if (pushedTracking && doc) {
      try {
        const { dispatchTrackWebhook } = require("../utils/dispatchTrackWebhook");
        // Merge the latest tracking into the order snapshot for the payload
        const orderSnapshot = doc.toObject ? doc.toObject() : { ...doc };
        // The pushed entry is the latest tracking event
        const latestTracking = pushedTracking;
        // Append it to tracking history for the payload
        if (!Array.isArray(orderSnapshot.tracking)) orderSnapshot.tracking = [];
        orderSnapshot.tracking = [...orderSnapshot.tracking, latestTracking];
        // Reflect any status change in snapshot
        if (update.$set?.status) orderSnapshot.status = update.$set.status;
        dispatchTrackWebhook(orderSnapshot, latestTracking);
      } catch (err) {
        console.error("Track Webhook (findOneAndUpdate) error:", err);
      }
    }
  } catch (err) {
    console.error("findOneAndUpdate Notification Hook error:", err);
  }
});

const Shipment = mongoose.model("newOrder", orderSchema);

module.exports = Shipment;

// 27684
// 19949

// 2000+2500=4500-8600=4100

// 216401000503
