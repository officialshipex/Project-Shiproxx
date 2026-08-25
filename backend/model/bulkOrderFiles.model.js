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
    // Per-row failure detail — previously computed in memory during upload
    // and discarded once the HTTP response was sent, so a past upload's
    // failures could never be revisited. Now persisted for the notification
    // detail view.
    rowResults: [{
        row: Number,
        message: String,
    }],
    // Display-only — both B2C and B2B uploads share this one collection
    // with no prior discriminator field.
    category: {
        type: String,
        enum: ['B2C', 'B2B'],
    },
});

const BulkOrderFiles = mongoose.model('BulkOrderFiles', bulkOrdersFileSchema);
module.exports = BulkOrderFiles;
