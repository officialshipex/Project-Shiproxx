const mongoose = require('mongoose');

const bulkOrdersFileSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true,
    },
    date: {
        type: Date,
        default: Date.now,
    },
    status: {
        type: String,
        enum: ['Processing', 'Completed',"Partial", 'Error'],
        default: 'Processing',
    },
    noOfOrders: {
        type: Number,
        default: 0,
    },
    successfullyUploaded: {
        type: Number,
        default: 0,
    },
    errorOrders: {
        type: Number,
        default: 0,
    },
    // Per-row outcome — previously only failures were kept in memory during
    // upload and discarded once the HTTP response was sent, so neither a past
    // upload's failures nor which order each successful row became could ever
    // be revisited. Now persisted (both outcomes) for the notification detail
    // view.
    rowResults: [{
        row: Number,
        status: { type: String, enum: ['success', 'failed'] },
        orderId: Number,
        message: String,
    }],
    // Display-only — both B2C and B2B uploads share this one collection
    // with no prior discriminator field.
    category: {
        type: String,
        enum: ['B2C', 'B2B'],
    },
}, { timestamps: true });

const BulkOrderFiles = mongoose.model('BulkOrderFiles', bulkOrdersFileSchema);
module.exports = BulkOrderFiles;
