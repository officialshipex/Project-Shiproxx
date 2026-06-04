const User = require("../models/User.model");
const RateCard = require("../models/rateCards");
const CustomRate = require("../models/CustomRate");
const mongoose = require('mongoose');

const saveCustomRate = async (req, res) => {
    try {
        let id = req.body.user;

        let user = await User.findById(id);
        if (!user) {
            return res.status(404).send({ message: "User not found" });
        }

        let customPlan;
        if (user.ratecards.length !== 0) {
            customPlan = await CustomRate.findById(user.ratecards[0]);
            if (!customPlan) {
                customPlan = new CustomRate();
                await customPlan.save();
            }
        } else {
            customPlan = new CustomRate();
            user.ratecards.push(customPlan._id);
            await customPlan.save();
            await user.save();
        }

        if (!customPlan.ratecards) {
            customPlan.ratecards = [];
        }
        if (!customPlan.users) {
            customPlan.users = [];
        }

        let ratecard = new RateCard({
            courierProviderName: req.body.courierProviderName,
            courierServiceName: req.body.courierServiceName,
            weightPriceBasic: req.body.weightPriceBasic,
            weightPriceAdditional: req.body.weightPriceAdditional,
            codPercent: req.body.codPercent,
            codCharge: req.body.codCharge,
        });

        await ratecard.save();

        customPlan.ratecards.push(ratecard._id);
        if (!customPlan.users.includes(req.body.user)) {
            customPlan.users.push(req.body.user);
        }

        await customPlan.save();
        await user.save();

        res.status(200).send({ message: "Custom rate saved successfully", ratecard });

    } catch (error) {
        console.error("Error saving custom rate:", error);
        res.status(500).send({ message: "Server error" });
    }
};

const printUserCount = async () => {
    try {
        const count = await User.countDocuments();
        console.log(`Total users present: ${count}`);
        return count;
    } catch (error) {
        console.error("Error fetching user count:", error);
    }
};


module.exports = { saveCustomRate, printUserCount };







