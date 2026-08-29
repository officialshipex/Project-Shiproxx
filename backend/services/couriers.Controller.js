const Plan = require("../models/Plan.model");

// Same pattern as getpickupAddress (Orders/newOrder.controller.js) — a plain
// customer session always uses their own id (an override is never honored,
// or any customer could target another customer's Plan); an admin/employee
// session must supply an explicit, validated userId since req.user is never
// populated for an employee JWT in this backend.
const resolveTargetUserId = (req) => {
  const isAdmin = req.user?.isAdmin === true && req.user?.adminTab === true;
  const isEmployee = req.isEmployee === true || !!req.employee;
  if (!isAdmin && !isEmployee) {
    return req.user?._id?.toString() || null;
  }
  const raw = req.query?.userId;
  const isValid = raw && !["all", "undefined", "null", ""].includes(raw.trim());
  return isValid ? raw.trim() : null;
};

const saveCourierPriority = async (req, res) => {
  try {
    const { type, couriers } = req.body;
    const userId = resolveTargetUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: "Unable to determine target user." });
    }

    // console.log("Incoming data:", req.body);

    if (!type) {
      return res
        .status(400)
        .json({ success: false, message: "Type is required" });
    }

    // ✅ Find user's plan
    const plan = await Plan.findOne({ userId });

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Plan not found for this user.",
      });
    }

    if (type === "Custom") {
      if (!couriers || couriers.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Courier list required for Custom type.",
        });
      }

      // ✅ Save courierPriority with only name, provider, mode
      plan.courierPriority = couriers.map((c) => ({
        name: c.name,
        provider: c.provider,
        mode: c.mode,
      }));

      // ✅ Reorder rateCard based on courierPriority — keyed on name+provider+mode,
      // not name alone, since two rateCard rows can share a courierServiceName
      // with a different mode (e.g. Surface vs Air for the same courier), and
      // matching by name alone collapsed both to the same rank.
      const keyOf = (name, provider, mode) => `${name || ""}|||${provider || ""}|||${mode || ""}`;
      const priorityKeys = plan.courierPriority.map((c) => keyOf(c.name, c.provider, c.mode));

      const reorderedRateCard = [
        // first: match rateCard with courierPriority order
        ...plan.rateCard
          .filter((item) => priorityKeys.includes(keyOf(item.courierServiceName, item.courierProviderName, item.mode)))
          .sort(
            (a, b) =>
              priorityKeys.indexOf(keyOf(a.courierServiceName, a.courierProviderName, a.mode)) -
              priorityKeys.indexOf(keyOf(b.courierServiceName, b.courierProviderName, b.mode))
          ),
        // then: keep remaining rateCard items
        ...plan.rateCard.filter(
          (item) => !priorityKeys.includes(keyOf(item.courierServiceName, item.courierProviderName, item.mode))
        ),
      ];
      // console.log("courierPriority", plan.courierPriority);
      // console.log("reorder", reorderedRateCard);
      plan.rateCard = reorderedRateCard;
      plan.priorityType = "Custom"; // optional field
    } else {
      plan.priorityType = type;
      plan.courierPriority = []; // clear previous custom priority
    }

    // ✅ Save the plan
    await plan.save();

    res.status(200).json({
      success: true,
      message: "Courier priority updated successfully inside Plan.",
      data: plan,
    });
  } catch (error) {
    console.error("Error saving courier priority:", error);
    res.status(500).json({
      success: false,
      message: "Server error while saving courier priority.",
    });
  }
};

const getCourierServices = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: "Unable to determine target user." });
    }

    // Find the plan for the target user
    const plan = await Plan.findOne({ userId });

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Plan not found for this user.",
      });
    }

    if (!plan.rateCard || plan.rateCard.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No rate card data available for this plan.",
      });
    }

    // Extract required fields from rateCard
    const formattedRateCard = plan.rateCard.map((card) => ({
      courierServiceName: card.courierServiceName || "",
      courierProviderName: card.courierProviderName || "",
      mode: card.mode || "",
      status: card.status,
    }));

    // Include courierPriority if exists
    const courierPriority = plan.courierPriority || [];

    // console.log("Formatted RateCard:", formattedRateCard);
    // console.log("Courier Priority:", courierPriority);

    res.status(200).json({
      success: true,
      message: "Courier rate card and priority fetched successfully.",
      data: {
        rateCard: formattedRateCard,
        courierPriority,
        priorityType: plan.priorityType,
      },
    });
  } catch (error) {
    console.error("Error fetching courier rate card:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching courier rate card.",
    });
  }
};

const updateCourierServiceStatus = async (req, res) => {
  try {
    const userId = req.user._id;
    const { courierServiceName, courierProviderName, status } = req.body;

    if (!courierServiceName || !courierProviderName || !status) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields: courierServiceName, courierProviderName, or status.",
      });
    }

    // Update rate card status atomically
    const plan = await Plan.findOneAndUpdate(
      {
        userId,
        "rateCard.courierServiceName": courierServiceName,
        "rateCard.courierProviderName": courierProviderName,
      },
      {
        $set: { "rateCard.$.status": status },
      },
      { new: true } // return updated document
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Plan or courier service not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Courier service status updated to ${status} successfully.`,
      updatedService: {
        courierServiceName,
        courierProviderName,
        status,
      },
    });
  } catch (error) {
    console.error("Error updating courier status:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while updating courier service status.",
    });
  }
};

module.exports = {
  saveCourierPriority,
  getCourierServices,
  updateCourierServiceStatus,
};
