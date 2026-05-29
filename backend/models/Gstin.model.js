const mongoose = require('mongoose');

const gstinSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true,
    },
    gstin: {
        type: String,
        required: true,
        unique: true,
    },
    nameOfBusiness: {
        type: String,
        // required: true,
    },

    referenceId: {
        type: String,
        required: true,
    },
    legalNameOfBusiness: {
        type: String,
        required: true,
    },
    taxPayerType: {
        type: String,
        required: true,
    },
    gstInStatus: {
        type: String,
        required: true,
    },
    dateOfRegistration: {
        type: Date,
        required: true,
    },
    address: {
        type: String
    },
    city: {
        type: String
    },
    state: {
        type: String
    },
    pincode: {
        type: Number
    }
});

const Gstin = mongoose.model.Gstin || mongoose.model('gstin', gstinSchema);

module.exports = Gstin;