const express = require("express");
const router = express.Router();
const CourierService = require("../models/CourierService.Schema");
const Plan = require("../models/Plan.model");
const RateCard = require("../models/rateCards");
const mongoose = require("mongoose");

// ✅ Get All Courier Services
router.get("/couriers", async (req, res) => {
  try {
    const couriers = await CourierService.find();
    res.status(200).json(couriers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Create New Courier Service
router.post("/couriers", async (req, res) => {
  try {
    const { provider, courier, courierType, name, status, courier_id } = req.body;

    const newCourier = new CourierService({
      provider,
      courier,
      courierType,
      name,
      status,
      courier_id,
    });
    console.log(req.body);
    await newCourier.save();
    res.status(201).json(newCourier);
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
});

router.put("/updateStatus/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !["Enable", "Disable"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status value" });
    }

    const updatedCourier = await CourierService.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!updatedCourier) {
      return res
        .status(404)
        .json({ success: false, message: "Courier not found" });
    }

    res
      .status(200)
      .json({ success: true, message: "Status updated", data: updatedCourier });
  } catch (error) {
    console.error("Error updating courier status:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Background helper for cascading updates
const cascadeProviderChange = async (serviceName, targetProvider) => {
  try {
    console.log(`[Background-Cascade] Starting provider update cascade for service: ${serviceName} -> target: ${targetProvider}`);
    const startTime = Date.now();

    // 1. Update global RateCard collection
    const rateCardResult = await RateCard.updateMany(
      { courierServiceName: serviceName },
      { $set: { courierProviderName: targetProvider } }
    );
    console.log(`[Background-Cascade] RateCard collection updated. Matched/Modified: ${rateCardResult.matchedCount}/${rateCardResult.modifiedCount}`);

    // 2. Update all Plans in one atomic updateMany query
    const result = await Plan.updateMany(
      { "rateCard.courierServiceName": serviceName },
      {
        $set: {
          "rateCard.$[rc].courierProviderName": targetProvider,
        },
      },
      {
        arrayFilters: [{ "rc.courierServiceName": serviceName }],
      }
    );

    console.log(`[Background-Cascade] Successfully updated plans. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount} in ${Date.now() - startTime}ms.`);
  } catch (error) {
    console.error("[Background-Cascade] Error in cascading provider change:", error);
  }
};

// Background helper for bulk provider updates cascade
const cascadeBulkProviderChange = async (serviceNames, targetProvider) => {
  try {
    console.log(`[Background-Cascade] Starting bulk provider update cascade for services: [${serviceNames.join(", ")}] -> target: ${targetProvider}`);
    const startTime = Date.now();

    // 1. Update global RateCard collection
    const rateCardResult = await RateCard.updateMany(
      { courierServiceName: { $in: serviceNames } },
      { $set: { courierProviderName: targetProvider } }
    );
    console.log(`[Background-Cascade] Bulk RateCard updated. Matched/Modified: ${rateCardResult.matchedCount}/${rateCardResult.modifiedCount}`);

    // 2. Update all Plans in one atomic updateMany query
    const result = await Plan.updateMany(
      { "rateCard.courierServiceName": { $in: serviceNames } },
      {
        $set: {
          "rateCard.$[rc].courierProviderName": targetProvider,
        },
      },
      {
        arrayFilters: [{ "rc.courierServiceName": { $in: serviceNames } }],
      }
    );

    console.log(`[Background-Cascade] Successfully completed bulk update for plans. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount} in ${Date.now() - startTime}ms.`);
  } catch (error) {
    console.error("[Background-Cascade] Error in bulk cascading provider change:", error);
  }
};

// Background helper for cascading a courier-service rename — RateCard and
// every Plan.rateCard entry store their own independent copy of
// courierServiceName (not a live reference, see cascadeProviderChange above),
// so renaming a CourierService leaves every rate card that already priced it
// pointing at the old name until this runs.
const cascadeNameChange = async (oldName, newName) => {
  try {
    console.log(`[Background-Cascade] Starting name update cascade: "${oldName}" -> "${newName}"`);
    const startTime = Date.now();

    const rateCardResult = await RateCard.updateMany(
      { courierServiceName: oldName },
      { $set: { courierServiceName: newName } }
    );
    console.log(`[Background-Cascade] RateCard collection updated. Matched/Modified: ${rateCardResult.matchedCount}/${rateCardResult.modifiedCount}`);

    const result = await Plan.updateMany(
      { "rateCard.courierServiceName": oldName },
      {
        $set: {
          "rateCard.$[rc].courierServiceName": newName,
        },
      },
      {
        arrayFilters: [{ "rc.courierServiceName": oldName }],
      }
    );

    console.log(`[Background-Cascade] Successfully updated plans for rename. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount} in ${Date.now() - startTime}ms.`);
  } catch (error) {
    console.error("[Background-Cascade] Error in cascading name change:", error);
  }
};

// ✅ Update Courier Service
router.put("/couriers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const oldService = await CourierService.findById(id);
    if (!oldService) {
      return res.status(404).json({ message: "Courier not found" });
    }

    const providerChanged = updateData.provider && updateData.provider !== oldService.provider;
    const nameChanged = updateData.name && updateData.name !== oldService.name;

    const updatedCourier = await CourierService.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    );

    if (nameChanged || providerChanged) {
      // Run both cascades in the background (don't block the response), but
      // rename must finish first: cascadeProviderChange matches RateCard/Plan
      // rows by courierServiceName using the NEW name, which won't exist on
      // those rows yet if the rename cascade hasn't landed — running them out
      // of order would silently no-op the provider cascade whenever a request
      // changes both name and provider together.
      (async () => {
        if (nameChanged) {
          await cascadeNameChange(oldService.name, updateData.name);
        }
        if (providerChanged) {
          await cascadeProviderChange(updatedCourier.name, updateData.provider);
        }
      })().catch(err => {
        console.error("[Background-Cascade] Trigger error:", err);
      });
    }

    res.status(200).json(updatedCourier);
  } catch (error) {
    console.error("Update Courier Error:", error);
    res.status(400).json({ error: error.message });
  }
});

// ✅ Bulk Change Provider
router.post("/changeProvider", async (req, res) => {
  try {
    const { serviceIds, targetProvider } = req.body;

    if (!serviceIds || !Array.isArray(serviceIds) || serviceIds.length === 0) {
      return res.status(400).json({ success: false, message: "No services selected" });
    }

    if (!targetProvider) {
      return res.status(400).json({ success: false, message: "Target provider is required" });
    }

    // 1. Fetch services to get names and check current providers
    const services = await CourierService.find({ _id: { $in: serviceIds } });
    if (services.length === 0) {
      return res.status(404).json({ success: false, message: "Selected services not found" });
    }

    const firstProvider = services[0].provider;
    const allSame = services.every(s => s.provider === firstProvider);
    if (!allSame) {
      return res.status(400).json({ success: false, message: "All selected services must have the same provider" });
    }

    const serviceNames = services.map(s => s.name);

    // 2. Update CourierService collection immediately
    await CourierService.updateMany(
      { _id: { $in: serviceIds } },
      { $set: { provider: targetProvider } }
    );

    // 3. Trigger cascading updates in the background
    cascadeBulkProviderChange(serviceNames, targetProvider).catch(err => {
      console.error("[Background-Cascade] Bulk trigger error:", err);
    });

    res.status(200).json({ 
      success: true, 
      message: `Provider update initiated. Switched ${services.length} services to ${targetProvider}. System is updating user plans in the background.` 
    });
  } catch (error) {
    console.error("Change Provider Error:", error);
    res.status(500).json({ success: false, message: "Internal server error", error: error.message });
  }
});

// ✅ Delete Courier Service
router.delete("/couriers/:id", async (req, res) => {
  try {
    const deletedCourier = await CourierService.findByIdAndDelete(
      req.params.id
    );
    if (!deletedCourier) {
      return res.status(404).json({ message: "Courier not found" });
    }
    res.status(200).json({ message: "Courier deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
