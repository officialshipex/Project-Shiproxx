const RateCard = require("../models/rateCards");
// const CourierServiceSecond = require("../models/courierServiceSecond.model");
const Plan = require("../models/Plan.model");
const multer = require("multer");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const createPlanNameSchema = require("../models/createPlanName.model");
const Couriers = require("../models/AllCourierSchema");
const CourierService = require("../models/CourierService.Schema");
const PlanName = require("../models/createPlanName.model");
const B2BRateCard = require("../B2B/models/ratecard.model");
const ActivityLog = require("../models/ActivityLog.model");

const normalizeRateCard = (data) => {
  const parseObj = (obj) => {
    if (!obj) return {};
    const result = { ...obj };
    ["weight", "zoneA", "zoneB", "zoneC", "zoneD", "zoneE"].forEach(key => {
      if (result[key] !== undefined) {
        result[key] = parseFloat(result[key]) || 0;
      }
    });
    return result;
  };

  const wrapArray = (val) => {
    if (Array.isArray(val)) return val.map(parseObj);
    if (val && typeof val === "object") return [parseObj(val)];
    return [];
  };

  return {
    ...data,
    weightPriceBasic: wrapArray(data.weightPriceBasic),
    weightPriceAdditional: wrapArray(data.weightPriceAdditional),
    codPercent: parseFloat(data.codPercent) || 0,
    codCharge: parseFloat(data.codCharge) || 0,
  };
};

const saveRate = async (req, res) => {
  try {
    const normalizedData = normalizeRateCard(req.body);
    const {
      plan,
      courierProviderName,
      mode,
      courierServiceName,
      weightPriceBasic,
      weightPriceAdditional,
      isFlatRate,
      codPercent,
      codCharge,
      status,
      shipmentType,
      userId // Added userId for user-specific override
    } = normalizedData;

    // Function to check required fields
    const checkRequiredFields = (weightData) => {
      if (!weightData) return true; // Optional for some fields
      return weightData.every((weight) => {
        return (
          weight.zoneA !== undefined &&
          weight.zoneB !== undefined &&
          weight.zoneC !== undefined &&
          weight.zoneD !== undefined &&
          weight.zoneE !== undefined
        );
      });
    };

    if (
      !checkRequiredFields(weightPriceBasic) ||
      !checkRequiredFields(weightPriceAdditional)
    ) {
      return res.status(400).json({
        message:
          "Missing required fields for zone rates (e.g. zoneA, zoneB, etc.).",
      });
    }

    // If userId is provided, handle user-specific override without affecting global RateCard collection
    if (userId) {
      const userPlan = await Plan.findOne({ userId });
      if (!userPlan) {
        return res.status(404).json({ message: "User plan not found" });
      }

      const rateCardData = {
        _id: new (require("mongoose")).Types.ObjectId(),
        ...normalizedData
      };

      const existingIdx = userPlan.rateCard.findIndex(
        (rc) =>
          rc.courierServiceName === courierServiceName &&
          rc.courierProviderName === courierProviderName
      );

      if (existingIdx !== -1) {
        // Maintain the same ID if it exists
        rateCardData._id = userPlan.rateCard[existingIdx]._id || rateCardData._id;
        userPlan.rateCard[existingIdx] = rateCardData;
      } else {
        userPlan.rateCard.push(rateCardData);
      }

      userPlan.markModified("rateCard");
      await userPlan.save();

      return res.status(201).json({
        message: "Rate card updated for user successfully (Isolated).",
        rateCard: rateCardData
      });
    }

    // --- Global Behavior below (only reached if no userId) ---

    // Check if the rate card already exists
    let existingRateCard = await RateCard.findOne({
      plan,
      mode,
      courierProviderName,
      courierServiceName,
    });

    let savedRateCard;

    if (existingRateCard) {
      // Update existing rate card
      Object.assign(existingRateCard, normalizedData);

      savedRateCard = await existingRateCard.save();
    } else {
      // Create new rate card
      savedRateCard = await RateCard.create({ ...normalizedData, defaultRate: true });
    }

    // **Update all users' rateCard field who have the same plan** (Original global behavior)
    await Plan.updateMany(
      { planName: plan },
      { $push: { rateCard: savedRateCard } }
    );

    console.log(`Updated users with plan "${plan}" to include new rate card`);

    return res.status(201).json({
      message: `${plan} rate card has been saved successfully.`,
      rateCard: savedRateCard
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error saving or updating Rate Card" });
  }
};

const getRateCard = async (req, res) => {
  try {
    const { userId } = req.query;
    if (userId) {
      const userPlan = await Plan.findOne({ userId });
      return res.status(200).json({
        message: "User rate cards retrieved successfully",
        rateCards: userPlan ? userPlan.rateCard : [],
      });
    }

    const allRateCard = await RateCard.find();
    res.status(200).json({
      message: "Rate cards retrieved successfully",
      rateCards: allRateCard,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Error retrieving rate cards" });
  }
};

const getUsersWithPlans = async (req, res) => {
  try {
    // Fetch all plans with user details
    const usersWithPlans = await Plan.find({});

    if (!usersWithPlans || usersWithPlans.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No users found with assigned plans",
      });
    }
    // console.log(usersWithPlans);

    res.status(200).json({
      success: true,
      data: usersWithPlans,
    });
  } catch (error) {
    console.error("Error fetching users with plans:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users with assigned plans",
      error: error.message,
    });
  }
};

// Background helper for cascading rate card updates to all user plans
const cascadeRateCardUpdate = async (rateCardId, rateCardData, planName) => {
  try {
    console.log(`[Background-Cascade] Starting global rate card update cascade for ID: ${rateCardId}, Plan: ${planName}`);
    const startTime = Date.now();

    const targetId = mongoose.Types.ObjectId.isValid(rateCardId)
      ? new mongoose.Types.ObjectId(rateCardId.toString())
      : rateCardId;

    const result = await Plan.updateMany(
      { 
        planName,
        $or: [
          { "rateCard._id": targetId },
          { "rateCard._id": rateCardId.toString() }
        ]
      },
      {
        $set: {
          "rateCard.$[rc]": rateCardData,
        },
      },
      {
        arrayFilters: [
          { 
            $or: [
              { "rc._id": targetId },
              { "rc._id": rateCardId.toString() }
            ]
          }
        ],
      }
    );

    console.log(`[Background-Cascade] Successfully updated plans globally. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount} in ${Date.now() - startTime}ms.`);
  } catch (error) {
    console.error("[Background-Cascade] Error in cascading rate card update:", error);
  }
};

// Background helper for cascading rate card deletions to all user plans
const cascadeRateCardDelete = async (rateCardId, planName) => {
  try {
    console.log(`[Background-Cascade] Starting global rate card delete cascade for ID: ${rateCardId}, Plan: ${planName}`);
    const startTime = Date.now();

    const targetId = mongoose.Types.ObjectId.isValid(rateCardId)
      ? new mongoose.Types.ObjectId(rateCardId.toString())
      : rateCardId;

    const result = await Plan.updateMany(
      { planName },
      {
        $pull: {
          rateCard: {
            $or: [
              { _id: targetId },
              { _id: rateCardId.toString() }
            ]
          }
        }
      }
    );

    console.log(`[Background-Cascade] Successfully deleted rate card from plans globally. Matched: ${result.matchedCount}, Modified: ${result.modifiedCount} in ${Date.now() - startTime}ms.`);
  } catch (error) {
    console.error("[Background-Cascade] Error in cascading rate card delete:", error);
  }
};

// Update Rate Card
const updateRateCard = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    const normalizedData = normalizeRateCard(req.body);

    if (userId) {
      // Step 1: Update ONLY specific user's plan
      const plan = await Plan.findOne({ userId });
      if (!plan) {
        return res.status(404).json({ message: "User plan not found" });
      }

      let modified = false;
      plan.rateCard = plan.rateCard.map((rc) => {
        if (rc._id.toString() === id) {
          modified = true;
          return {
            ...rc._doc || rc,
            ...normalizedData,
            _id: id 
          };
        }
        return rc;
      });

      if (!modified) {
        return res.status(404).json({ message: "Rate card not found in user plan" });
      }

      plan.markModified("rateCard");
      await plan.save();

      return res.status(200).json({
        message: "User rate card updated successfully (Isolated).",
      });
    }

    // --- Global Behavior below (only reached if no userId) ---

    // Step 1: Update the main RateCard document
    const updatedRateCard = await RateCard.findByIdAndUpdate(id, normalizedData, {
      new: true,
      runValidators: true,
    });

    if (!updatedRateCard) {
      return res.status(404).json({ message: "Rate Card not found" });
    }

    // Step 2: Trigger background cascade to update all user plans asynchronously
    cascadeRateCardUpdate(id, updatedRateCard.toObject(), updatedRateCard.plan).catch(err => {
      console.error("[Background-Cascade] Trigger error for update:", err);
    });
 
    // Log the action
    const performerId = req.user?._id || req.employee?._id;
    if (performerId) {
      await ActivityLog.create({
        performedBy: performerId,
        action: "UPDATE",
        module: "RATE_CARD",
        planName: updatedRateCard.plan,
        details: {
          rateCardId: id,
          updatedFields: Object.keys(req.body)
        }
      });
    }

    res.status(200).json({
      message: "Rate Card updated globally.",
      rateCard: updatedRateCard,
    });
  } catch (error) {
    console.error("Error updating rate card:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const deleteRateCard = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (userId) {
      const plan = await Plan.findOne({ userId });
      if (plan) {
        plan.rateCard = plan.rateCard.filter((rc) => rc._id.toString() !== id);
        plan.markModified("rateCard");
        await plan.save();
      }
      return res.status(200).json({ message: "Rate card removed from user plan successfully (Isolated)." });
    }

    // --- Global Behavior below ---

    // Step 1: Delete the RateCard document
    const deletedRateCard = await RateCard.findByIdAndDelete(id);

    if (!deletedRateCard) {
      return res.status(404).json({ message: "Rate Card not found" });
    }

    // Step 2: Trigger background cascade to remove from all user plans asynchronously
    cascadeRateCardDelete(id, deletedRateCard.plan).catch(err => {
      console.error("[Background-Cascade] Trigger error for delete:", err);
    });

    // Log the action
    const performerId = req.user?._id || req.employee?._id;
    if (performerId) {
      await ActivityLog.create({
        performedBy: performerId,
        action: "DELETE",
        module: "RATE_CARD",
        planName: deletedRateCard.plan,
        details: {
          rateCardId: id,
          courierServiceName: deletedRateCard.courierServiceName
        }
      });
    }

    res.status(200).json({
      message: "Rate Card deleted and removed from all matching plans.",
    });
  } catch (error) {
    console.error("Error deleting rate card from plans:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
};

const getRateCardById = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    let rateCard;

    if (userId) {
      const userPlan = await Plan.findOne({ userId });
      if (userPlan) {
        rateCard = userPlan.rateCard.find((rc) => rc._id.toString() === id);
      }
    }

    if (!rateCard) {
      rateCard = await RateCard.findById(id);
    }

    if (!rateCard) {
      return res.status(404).json({ message: "Rate Card not found" });
    }

    res.status(200).json({ message: "Rate card retrieved successfully", rateCard });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error retrieving rate card" });
  }
};

const getPlan = async (req, res) => {
  try {
    const allPlan = await Plan.findOne({ userId: req.user._id });

    if (!allPlan) {
      return res.status(404).json({
        success: false,
        message: "Plan not found for the user.",
      });
    }

    res.status(200).json({
      success: true,
      message: "Plan retrieved successfully.",
      data: allPlan.rateCard, // Sending only rateCard, modify if needed
    });
  } catch (error) {
    console.error("Error fetching plan:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error. Please try again later.",
      error: error.message, // Optional, useful for debugging
    });
  }
};

const createPlanName = async (req, res) => {
  try {
    const userId = req.user._id; // Assuming user ID is in req.user from auth middleware
    const { planName } = req.body;

    if (!planName || planName.trim() === "") {
      return res.status(400).json({ message: "Plan name is required" });
    }

    const existing = await createPlanNameSchema.findOne({
      name: planName.trim(),
    });
    if (existing) {
      return res.status(409).json({ message: "Plan already exists" });
    }

    const plan = new createPlanNameSchema({
      name: planName.trim(),
      createdBy: userId, // Save userId here
    });

    await plan.save();
    return res.status(201).json({ message: "Plan created successfully", plan });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

const getPlanNames = async (req, res) => {
  try {
    const plans = await createPlanNameSchema
      .find({}, { name: 1, _id: 0 })
      .sort({ createdAt: -1 }) // Sort by newest first
      .lean();

    const planNames = plans.map((plan) => plan.name);

    return res.status(200).json({ planNames });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

// const exportDemoRatecard = async (req, res) => {
//   try {
//     const workbook = new ExcelJS.Workbook();
//     const worksheet = workbook.addWorksheet("RateCard Demo");

//     // Define columns for all required rate card fields
//     worksheet.columns = [
//       { header: "Plan Name", key: "planName", width: 20 },
//       {
//         header: "Courier Provider Name",
//         key: "courierProviderName",
//         width: 25,
//       },
//       { header: "Courier Service Name", key: "courierServiceName", width: 25 },
//       // { header: "Mode", key: "mode", width: 15 },
//       // { header: "Status", key: "status", width: 15 },
//       // { header: "Shipment Type", key: "shipmentType", width: 15 },
//       // Basic weights and rates
//       { header: "Basic Weight", key: "basicWeight", width: 15 },
//       { header: "Basic Zone A", key: "basicZoneA", width: 10 },
//       { header: "Basic Zone B", key: "basicZoneB", width: 10 },
//       { header: "Basic Zone C", key: "basicZoneC", width: 10 },
//       { header: "Basic Zone D", key: "basicZoneD", width: 10 },
//       { header: "Basic Zone E", key: "basicZoneE", width: 10 },
//       // Additional weights and rates
//       { header: "Additional Weight", key: "additionalWeight", width: 15 },
//       { header: "Additional Zone A", key: "additionalZoneA", width: 10 },
//       { header: "Additional Zone B", key: "additionalZoneB", width: 10 },
//       { header: "Additional Zone C", key: "additionalZoneC", width: 10 },
//       { header: "Additional Zone D", key: "additionalZoneD", width: 10 },
//       { header: "Additional Zone E", key: "additionalZoneE", width: 10 },
//       // COD
//       { header: "COD Percent", key: "codPercent", width: 15 },
//       { header: "COD Charge", key: "codCharge", width: 15 },
//     ];

//     // Add a demo data row for user reference
//     worksheet.addRow({
//       planName: "Silver (same as existing plans in system)",
//       courierProviderName: "Shipex (same as existing providers in system)",
//       courierServiceName:
//         "Shipex surface (same as existing services in system)",
//       basicWeight: "500 (in grams)",
//       basicZoneA: "50",
//       basicZoneB: "60",
//       basicZoneC: "70",
//       basicZoneD: "80",
//       basicZoneE: "90",
//       additionalWeight: "100 (in grams)",
//       additionalZoneA: "10",
//       additionalZoneB: "12",
//       additionalZoneC: "15",
//       additionalZoneD: "18",
//       additionalZoneE: "20",
//       codPercent: "2",
//       codCharge: "25",
//     });

//     // Set response headers for file download
//     res.setHeader(
//       "Content-Type",
//       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//     );
//     res.setHeader(
//       "Content-Disposition",
//       "attachment; filename=ratecard-demo.xlsx"
//     );

//     // Write workbook to response
//     await workbook.xlsx.write(res);
//     res.status(200).end();
//   } catch (error) {
//     console.error("Demo file export error:", error);
//     res.status(500).json({ message: "Error exporting demo file" });
//   }
// };

const exportDemoRatecard = async (req, res) => {
  try {
    const { hidePlan } = req.query;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("RateCard Demo");

    const columns = [
      { header: "Plan Name", key: "planName", width: 20 },
      { header: "Courier Service Name", key: "courierServiceName", width: 25 },
      { header: "Type Text", key: "typeText", width: 15 },
      { header: "weight", key: "weight", width: 12 },
      { header: "zoneA", key: "zoneA", width: 10 },
      { header: "zoneB", key: "zoneB", width: 10 },
      { header: "zoneC", key: "zoneC", width: 10 },
      { header: "zoneD", key: "zoneD", width: 10 },
      { header: "zoneE", key: "zoneE", width: 10 },
      { header: "COD Charge", key: "codCharge", width: 18 },
      { header: "COD_Percentage", key: "codPercentage", width: 15 },
      { header: "Is Flat Rate", key: "isFlatRate", width: 15 },
    ];

    worksheet.columns = hidePlan === "true" ? columns.filter(col => col.key !== "planName") : columns;

    // --- First ratecard: Basic and Additional ---
    worksheet.addRow({
      planName: "Silver",
      courierServiceName: "Bluedart Air",
      typeText: "Basic",
      weight: "0.5",
      zoneA: "56.00",
      zoneB: "67.00",
      zoneC: "89.00",
      zoneD: "96.00",
      zoneE: "125.00",
      codCharge: "35.4",
      codPercentage: "1.97",
      isFlatRate: "FALSE",
    });

    worksheet.addRow({
      planName: "Silver",
      courierServiceName: "Bluedart Air",
      typeText: "Additional",
      weight: "0.5",
      zoneA: "48.00",
      zoneB: "55.00",
      zoneC: "70.00",
      zoneD: "80.00",
      zoneE: "110.00",
      codCharge: "35.4",
      codPercentage: "1.97",
      isFlatRate: "",
    });

    // --- Second ratecard: Basic and Additional ---
    worksheet.addRow({
      planName: "Gold",
      courierServiceName: "Xpressbees Air",
      typeText: "Basic",
      weight: "0.5",
      zoneA: "48.00",
      zoneB: "53.00",
      zoneC: "73.00",
      zoneD: "79.00",
      zoneE: "100.00",
      codCharge: "32.78",
      codPercentage: "1.70",
      isFlatRate: "TRUE",
    });

    worksheet.addRow({
      planName: "Gold",
      courierServiceName: "Xpressbees Air",
      typeText: "Additional",
      weight: "0.5",
      zoneA: "43.00",
      zoneB: "46.00",
      zoneC: "61.00",
      zoneD: "67.00",
      zoneE: "83.00",
      codCharge: "32.78",
      codPercentage: "1.70",
      isFlatRate: "",
    });


    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=ratecard-demo.xlsx"
    );

    await workbook.xlsx.write(res);
    res.status(200).end();
  } catch (error) {
    console.error("Demo file export error:", error);
    res.status(500).json({ message: "Error exporting demo file" });
  }
};

const uploadRatecard = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Read Excel
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      fs.unlink(req.file.path, () => { });
      return res.status(400).json({ error: "No worksheet found" });
    }

    // Get header
    const rawKeys = worksheet.getRow(1).values;
    const keys = [];
    for (let i = 1; i < rawKeys.length; i++) {
      keys.push(String(rawKeys[i] || "").trim());
    }

    // Parse rows, skip empty
    const rows = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const obj = {};
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const key = keys[colNumber - 1];
        if (key) {
          // If cell has a formula or is a result, get the result
          obj[key] = cell.value?.result !== undefined ? cell.value.result : cell.value;
        }
      });
      // Only add if row has at least one non-empty cell
      if (Object.values(obj).some(v => v !== null && v !== "")) {
        rows.push(obj);
      }
    });

    // Delete temp file
    fs.unlink(req.file.path, () => { });

    if (rows.length === 0) {
      return res.status(400).json({ error: "No valid data rows found in Excel file." });
    }

    // Fetch sets for validation
    const [providers, services, plans] = await Promise.all([
      Couriers.find().lean(),
      CourierService.find().lean(),
      PlanName.find().lean(),
    ]);

    const normalize = (str = "") =>
      String(str || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_]/g, "");

    // Create normalized maps for easier lookup
    const providerMap = new Map();
    providers.forEach(p => {
      // Map by provider type (e.g. 'Ekart')
      providerMap.set(normalize(p.courierProvider), p);
      // Map by specific account name (e.g. 'Ekart-2')
      providerMap.set(normalize(p.courierName), p);
    });
    const serviceMap = new Map(services.map(s => [normalize(s.name), s]));
    const planSet = new Set(plans.map(p => normalize(p.name)));

    const errors = [];
    const savedRatecards = [];
    const updatedRatecards = [];
    const toFixedNum = (num) => {
      const val = parseFloat(num);
      return isNaN(val) ? 0 : Number(val.toFixed(2));
    };

    // Group rows by (plan, provider, service)
    const grouped = {};
    
    // Key names as they appear in the sample/template
    const H_PLAN = "Plan Name";
    const H_SERVICE = "Courier Service Name";
    const H_TYPE = "Type Text";
    const H_WEIGHT = "weight";
    const H_ZONEA = "zoneA";
    const H_ZONEB = "zoneB";
    const H_ZONEC = "zoneC";
    const H_ZONED = "zoneD";
    const H_ZONEE = "zoneE";
    const H_COD_CHARGE = "COD Charge";
    const H_COD_PERC = "COD_Percentage";
    const H_IS_FLAT = "Is Flat Rate";

    const { plan: targetPlan, replaceExisting, userId } = req.body;
    const performerId = req.user?._id;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const getRowVal = (headerName) => {
        const normHeader = normalize(headerName);
        const actualKey = Object.keys(row).find(k => normalize(k) === normHeader);
        return actualKey ? row[actualKey] : undefined;
      };

      const planVal = req.body.plan || getRowVal(H_PLAN) || getRowVal("Plan");
      const serviceVal = getRowVal(H_SERVICE) || getRowVal("Service");
      
      const plan = normalize(planVal);
      const service = normalize(serviceVal);

      // If userId is present, we don't strictly require the plan to be in the global PlanName collection
      if (userId) {
        if (!plan) {
          // If no plan provided in row or body, we'll use a fallback or handle it later
          // For now, let's assume req.body.plan was provided or we use a default
          if (!req.body.plan) {
             errors.push(`Row ${rowNum}: Plan Name is required even for user-specific uploads (it can be an auto-generated one)`);
             continue;
          }
        }
      } else {
        if (!plan || !planSet.has(plan)) {
          errors.push(`Row ${rowNum}: Invalid or missing Plan Name (${planVal || "Empty"})`);
          continue;
        }
      }

      const matchedService = serviceMap.get(service);
      if (!matchedService) {
        errors.push(`Row ${rowNum}: Invalid or missing Courier Service Name (${serviceVal || "Empty"})`);
        continue;
      }

      const providerName = matchedService.provider;
      const matchedProvider = providerMap.get(normalize(providerName));

      if (!matchedProvider || matchedProvider.status === "Disable") {
        errors.push(`Row ${rowNum}: Provider ${providerName} is either invalid or disabled`);
        continue;
      }

      const key = `${plan}__${normalize(providerName)}__${service}`;
      if (!grouped[key]) {
        const rawFlat = String(getRowVal(H_IS_FLAT) || getRowVal("Flat Rate") || "").trim().toLowerCase();
        const parsedIsFlatRate = rawFlat === "true" || rawFlat === "1" || rawFlat === "yes";

        grouped[key] = {
          plan: planVal,
          courierProviderName: providerName,
          courierServiceName: serviceVal,
          weightPriceBasic: [],
          weightPriceAdditional: [],
          codCharge: toFixedNum(getRowVal(H_COD_CHARGE)),
          codPercent: toFixedNum(getRowVal(H_COD_PERC)),
          isFlatRate: parsedIsFlatRate,
        };
      }

      const weightObj = {
        weight: toFixedNum(getRowVal(H_WEIGHT) || getRowVal("Weight Rate")) * 1000,
        zoneA: toFixedNum(getRowVal(H_ZONEA)),
        zoneB: toFixedNum(getRowVal(H_ZONEB)),
        zoneC: toFixedNum(getRowVal(H_ZONEC)),
        zoneD: toFixedNum(getRowVal(H_ZONED)),
        zoneE: toFixedNum(getRowVal(H_ZONEE)),
      };

      const typeTextRaw = getRowVal(H_TYPE) || getRowVal("Type");
      const typeText = normalize(typeTextRaw);
      if (typeText === "basic") {
        grouped[key].weightPriceBasic.push(weightObj);
      } else if (typeText === "additional") {
        grouped[key].weightPriceAdditional.push(weightObj);
      } else {
        errors.push(
          `Row ${rowNum}: Invalid Type Text "${typeTextRaw || "Empty"}" (must be Basic or Additional)`
        );
      }
    }

    // If there are validation errors, stop here without touching the database
    if (errors.length > 0) {
      return res.status(200).json({
        message: `Upload failed: ${errors.length} errors found. No changes were made.`,
        savedCount: 0,
        updatedCount: 0,
        errors,
        data: [],
      });
    }

    // --- NO ERRORS FOUND: START DATABASE MODIFICATIONS ---

    // 1. Clear existing rates if requested
    if (replaceExisting === "true") {
      if (userId) {
        // Only clear for this specific user
        await Plan.updateOne({ userId }, { $set: { rateCard: [] } });
        console.log(`Cleared existing rates for user: ${userId}`);
      } else {
        // Global clear
        const cardsToDelete = await RateCard.find({ plan: targetPlan });
        const cardIds = cardsToDelete.map(c => c._id);
        await RateCard.deleteMany({ plan: targetPlan });
        await Plan.updateMany({ planName: targetPlan }, { $pull: { rateCard: { _id: { $in: cardIds } } } });
        console.log(`Cleared existing rates for plan: ${targetPlan}`);
      }
    }

    let userPlanDoc = null;
    if (userId) {
      userPlanDoc = await Plan.findOne({ userId });
      if (userPlanDoc && targetPlan) {
        userPlanDoc.planName = targetPlan;
      }
    }

    // Save or update grouped ratecards
    for (const key in grouped) {
      const g = grouped[key];
      const mode = serviceMap.get(normalize(g.courierServiceName))?.courierType;

      const rateCardData = {
        plan: String(g.plan || "").trim(),
        mode: mode || "",
        courierProviderName: String(g.courierProviderName || "").trim(),
        courierServiceName: String(g.courierServiceName || "").trim(),
        weightPriceBasic: g.weightPriceBasic,
        weightPriceAdditional: g.weightPriceAdditional,
        codCharge: parseFloat(g.codCharge) || 0,
        codPercent: parseFloat(g.codPercent) || 0,
        isFlatRate: g.isFlatRate === true,
        status: "Active",
        shipmentType: "Forward",
        defaultRate: true,
      };

      if (userId && userPlanDoc) {
        // --- ISOLATED USER UPDATE ---
        const existingIdx = userPlanDoc.rateCard.findIndex(
          (rc) =>
            rc.courierServiceName === rateCardData.courierServiceName &&
            rc.courierProviderName === rateCardData.courierProviderName
        );

        if (existingIdx !== -1) {
          // Update existing in user's plan
          const updatedObj = { ...userPlanDoc.rateCard[existingIdx].toObject ? userPlanDoc.rateCard[existingIdx].toObject() : userPlanDoc.rateCard[existingIdx], ...rateCardData };
          userPlanDoc.rateCard[existingIdx] = updatedObj;
          updatedRatecards.push(updatedObj);
        } else {
          // Push new to user's plan
          const newObj = { ...rateCardData, _id: new (require("mongoose")).Types.ObjectId() };
          userPlanDoc.rateCard.push(newObj);
          savedRatecards.push(newObj);
        }
        userPlanDoc.markModified("rateCard");
      } else if (!userId) {
        // --- GLOBAL UPDATE ---
        const existing = await RateCard.findOne({
          plan: rateCardData.plan,
          courierProviderName: rateCardData.courierProviderName,
          courierServiceName: rateCardData.courierServiceName,
          shipmentType: "Forward",
        });

        if (existing) {
          Object.assign(existing, rateCardData);
          await existing.save();
          updatedRatecards.push(existing);

          // Update all users globally who have this rate card
          await Plan.updateMany(
            { planName: existing.plan, "rateCard.courierServiceName": existing.courierServiceName },
            { $set: { "rateCard.$": existing.toObject() } }
          );
        } else {
          const rateCardDoc = new RateCard(rateCardData);
          await rateCardDoc.save();
          savedRatecards.push(rateCardDoc);

          // Add to all users with this plan globally
          await Plan.updateMany(
            { planName: rateCardData.plan },
            { $push: { rateCard: rateCardDoc.toObject() } }
          );
        }
      }
    }

    if (userId && userPlanDoc) {
      await userPlanDoc.save();
    }

    // Log the action
    if (performerId) {
      await ActivityLog.create({
        performedBy: performerId,
        action: "UPLOAD",
        module: "RATE_CARD",
        planName: targetPlan || "Bulk Upload",
        details: {
          savedCount: savedRatecards.length,
          updatedCount: updatedRatecards.length,
          replaceExisting: replaceExisting === "true",
          errorsCount: errors.length
        }
      });
    }

    const finalMessage = `Processed ${rows.length} rows. Saved: ${savedRatecards.length}, Updated: ${updatedRatecards.length}, Errors: ${errors.length}`;

    return res.status(200).json({
      message: finalMessage,
      savedCount: savedRatecards.length,
      updatedCount: updatedRatecards.length,
      errors,
      data: [...savedRatecards, ...updatedRatecards],
    });
  } catch (err) {
    console.error("Upload ratecard error:", err);
    res.status(500).json({ error: "Failed to upload/process rate card file" });
  }
};

module.exports = {
  saveRate,
  getRateCard,
  getPlan,
  updateRateCard,
  deleteRateCard,
  getRateCardById,
  getUsersWithPlans,
  createPlanName,
  getPlanNames,
  exportDemoRatecard,
  uploadRatecard,
};
