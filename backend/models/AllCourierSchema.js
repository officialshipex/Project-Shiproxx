const mongoose = require('mongoose');
const { LEGACY_PROVIDER_MAP } = require('../utils/legacyProviderMap');

const allCourierSchema = new mongoose.Schema({
    courierName: {
        type: String,
        required: true,
        unique: true,
    },
    courierProvider: {
        type: String,
        required: true,
    },
    // Auto-assigned below (pre("validate") hook) — the dispatch id used
    // throughout the booking APIs (bookOrder/availableCourierService) to
    // route by provider name. One per configured account; multiple accounts
    // of the same courierProvider simply get different ids that both resolve
    // to the same provider name at dispatch time.
    courierId: {
        type: String,
        unique: true,
    },
    CODDays: {
        type: Number,
        required: false,
    },
    status: {
        type: String,
        required: true,
        enum: ["Enable", "Disable"],
      },
    email: {
        type: String,
        required: false,
    },
    apiKey: {
        type: String,
        required: false,
    },
    password: {
        type: String,
        required: false,
    },
    date: {
        type: Date,
        default: Date.now,
    },
});

// Auto-assign the next sequential courierId on creation — runs pre-validate
// (not pre-save) so it's already set by the time the schema's own validation
// runs. courierId is always a zero-padded 2-digit string, so a plain string
// sort on it is equivalent to a numeric sort.
allCourierSchema.pre("validate", async function (next) {
    if (this.isNew && !this.courierId) {
        try {
            // If this account is for one of the 14 known legacy providers AND
            // that provider's id isn't already taken by another account,
            // reuse ITS id rather than minting a fresh one — matched
            // case-insensitively against courierProvider since a couple of
            // provider configs save it differently-cased (e.g. DTDC saves
            // "DTDC" while the registered legacy id is against "Dtdc").
            // Without this, adding credentials for e.g. BoxdLogistics later
            // would give it a brand-new id instead of reusing "09", leaving
            // two ids pointing at the same provider.
            //
            // If that id IS already taken (a second account for a provider
            // that already has one), fall through to a fresh auto-incremented
            // id — every account still gets a unique courierId, no collision.
            const legacyEntry = Object.entries(LEGACY_PROVIDER_MAP).find(
                ([, name]) => name.toLowerCase() === (this.courierProvider || "").toLowerCase()
            );

            if (legacyEntry) {
                const legacyId = legacyEntry[0];
                const taken = await this.constructor.exists({ courierId: legacyId });
                if (!taken) {
                    this.courierId = legacyId;
                }
            }

            if (!this.courierId) {
                const last = await this.constructor
                    .findOne({ courierId: { $exists: true, $ne: null } })
                    .sort({ courierId: -1 })
                    .select("courierId")
                    .lean();
                const nextNumber = (last ? parseInt(last.courierId, 10) : 0) + 1;
                this.courierId = String(nextNumber).padStart(2, "0");
            }
        } catch (err) {
            return next(err);
        }
    }
    next();
});

const AllCourier = mongoose.models.AllCourier || mongoose.model('allCourier', allCourierSchema);
module.exports = AllCourier;
