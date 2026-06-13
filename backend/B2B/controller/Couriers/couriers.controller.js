const AllCourierB2B = require("../../models/AllCourier.model");
const CourierServicesB2B = require("../../models/courierService.model");
const fs = require("fs");
const path = require("path");
const csv = require("fast-csv");
const XLSX = require("xlsx");
const CourierPincodeB2B = require("../../models/serviceableCourierPincode.model");

const getAllCouriers = async (req, res) => {
  try {
    const couriers = await AllCourierB2B.find();
    res.status(200).json(couriers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAllCourierServices = async (req, res) => {
  try {
    const couriers = await CourierServicesB2B.find();
    res.status(200).json(couriers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
// ✅ Create New Courier Service
const createCourier = async (req, res) => {
  try {
    const { provider, courier, courierType, name, weight, status } = req.body;
    // console.log("Creating Courier with data:", req.body);
    const courierValue = Array.isArray(courier)
      ? courier[0].trim()
      : courier.trim();

    // 🔒 Duplicate check (same provider + same courier)
    const existingCourier = await CourierServicesB2B.findOne({
      provider: provider.trim(),
      courier: courierValue,
      name: name.trim(),
    });

    if (existingCourier) {
      return res.status(409).json({
        error: "Courier already exists for this provider",
      });
    }

    const newCourier = new CourierServicesB2B({
      provider: provider.trim(),
      courier: courierValue,
      courierType,
      name,
      weight,
      status,
    });

    await newCourier.save();

    res.status(201).json({
      success: true,
      message: "Courier created successfully",
      courier: newCourier,
    });
  } catch (error) {
    console.error("Create Courier Error:", error);
    res.status(400).json({ error: error.message });
  }
};

// ✅ Update Courier Status
const updateCourierServicesStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !["Enable", "Disable"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status value" });
    }

    const updatedCourier = await CourierServicesB2B.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!updatedCourier) {
      return res
        .status(404)
        .json({ success: false, message: "Courier not found" });
    }

    res.status(200).json({
      success: true,
      message: "Status updated",
      data: updatedCourier,
    });
  } catch (error) {
    console.error("Error updating courier status:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ✅ Update Courier Service
const updateCourier = async (req, res) => {
  try {
    console.log(req.params.id);

    const updatedCourier = await CourierServicesB2B.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!updatedCourier) {
      return res.status(404).json({ message: "Courier not found" });
    }

    res.status(200).json(updatedCourier);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ✅ Delete Courier Service
const deleteCourier = async (req, res) => {
  try {
    const deletedCourier = await AllCourierB2B.findByIdAndDelete(req.params.id);

    if (!deletedCourier) {
      return res.status(404).json({ message: "Courier not found" });
    }

    res.status(200).json({ message: "Courier deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateCourierStatus = async (req, res) => {
  try {
    // const { provider } = req.params; // e.g., 'DTDC'
    const { provider, status } = req.body; // 'Enable' or 'Disable'

    // Find and update by provider field
    const courier = await AllCourierB2B.findOneAndUpdate(
      { courierProvider: provider },
      { status },
      { new: true }
    );
    if (!courier) {
      return res.status(404).json({ message: "Courier not found" });
    }
    res.json({ message: "Status updated", courier });
  } catch (error) {
    res.status(500).json({ message: "Error updating status", error });
  }
};

// -----------------------------
// In-memory caches (Optimized)
// -----------------------------
const serviceCache = new Map(); // For quick repeated lookups
const courierPincodesMap = new Map(); // key = courierName, value = { pickupSet, deliverySet, codSet }

// -----------------------------
// Helper: Convert Y/N to boolean
// -----------------------------
const parseYN = (val) => val?.toString().trim().toUpperCase() === "Y";

// -----------------------------
// Load all courier pincodes into memory (called on server start)
// -----------------------------
const loadCourierPincodes = async () => {
  const allCouriers = await CourierPincodeB2B.find({})
    .lean()
    .select("courier pincodes");

  for (const c of allCouriers) {
    const pickupSet = new Set();
    const deliverySet = new Set();
    const codSet = new Set();

    for (const p of c.pincodes) {
      if (p.pickup) pickupSet.add(p.pincode.toString());
      if (p.delivery) deliverySet.add(p.pincode.toString());
      if (p.cod) codSet.add(p.pincode.toString());
    }

    courierPincodesMap.set(c.courier, { pickupSet, deliverySet, codSet });
  }

  console.log(`✅ Loaded pincodes for ${courierPincodesMap.size} couriers`);
};

// -----------------------------
// Upload CSV/XLSX
// -----------------------------
const uploadPincode = async (req, res) => {
  try {
    const { courier } = req.params;
    if (!req.file) return res.status(400).json({ message: "File is required" });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let pincodes = [];

    // Parse CSV
    if (ext === ".csv") {
      fs.createReadStream(req.file.path)
        .pipe(
          csv.parse({
            headers: true,
            skipEmptyLines: true,
            trim: true,
            bom: true,
          })
        )
        .on("error", (error) => {
          console.error(error);
          try { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
          return res.status(500).json({ message: "CSV parsing error" });
        })
        .on("data", (row) => {
          pincodes.push({
            pincode: row.Pincode,
            pickup: parseYN(row.Pickup),
            delivery: parseYN(row.Delivery),
            cod: parseYN(row.Cod),
          });
        })
        .on("end", async () => {
          pincodes = removeDuplicatePincodes(pincodes);
          console.log("Parsed pincodes:", pincodes.length);
          await saveCourierData(courier, pincodes, req.file.path, res);
        });

      // Parse XLSX
    } else if (ext === ".xlsx") {
      const workbook = XLSX.readFile(req.file.path);
      const sheet = XLSX.utils.sheet_to_json(
        workbook.Sheets[workbook.SheetNames[0]],
        { defval: "" }
      );

      sheet.forEach((row) => {
        pincodes.push({
          pincode: row.Pincode,
          pickup: parseYN(row.Pickup),
          delivery: parseYN(row.Delivery),
          cod: parseYN(row.Cod),
        });
      });

      pincodes = removeDuplicatePincodes(pincodes);
      await saveCourierData(courier, pincodes, req.file.path, res);
    } else {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: "Unsupported file type" });
    }
  } catch (err) {
    console.error(err);
    if (req.file && req.file.path) {
      try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
    }
    res.status(500).json({ message: "Internal server error" });
  }
};

// -----------------------------
// Helper: Remove duplicate pincodes
// -----------------------------
const removeDuplicatePincodes = (pincodes) => {
  const seen = new Set();
  const unique = [];

  for (const p of pincodes) {
    const pin = p.pincode?.toString().trim();
    if (pin && !seen.has(pin)) {
      seen.add(pin);
      unique.push(p);
    }
  }
  return unique;
};

// -----------------------------
// Save to DB and update in-memory map
// -----------------------------
const saveCourierData = async (courier, pincodes, filePath, res) => {
  try {
    let courierData = await CourierPincodeB2B.findOne({ courier });

    // Convert new pincodes to a map for fast lookup
    const newPincodeMap = new Map();
    for (const p of pincodes) {
      const pin = p.pincode?.toString().trim();
      if (pin) newPincodeMap.set(pin, p);
    }

    // Merge logic
    if (courierData) {
      const existingMap = new Map();
      courierData.pincodes.forEach((p) => {
        const pin = p.pincode?.toString().trim();
        if (pin) existingMap.set(pin, p);
      });

      // Update or add
      for (const [pin, newData] of newPincodeMap.entries()) {
        existingMap.set(pin, newData); // overwrite if exists, add if new
      }

      // Replace array
      courierData.pincodes = Array.from(existingMap.values());
    } else {
      courierData = new CourierPincodeB2B({ courier, pincodes });
    }

    // Save the merged data
    await courierData.save();

    // Build optimized sets for O(1) lookups
    const pickupSet = new Set();
    const deliverySet = new Set();
    const codSet = new Set();

    for (const p of courierData.pincodes) {
      const pin = p.pincode?.toString();
      if (p.pickup) pickupSet.add(pin);
      if (p.delivery) deliverySet.add(pin);
      if (p.cod) codSet.add(pin);
    }

    courierPincodesMap.set(courier, { pickupSet, deliverySet, codSet });

    // Cleanup
    fs.unlinkSync(filePath);

    res.json({
      message: "Pincodes uploaded and merged successfully",
      total: courierData.pincodes.length,
      newAdded: pincodes.length,
    });
  } catch (error) {
    console.error("Error saving courier data:", error);
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
    res.status(500).json({ message: "Internal server error" });
  }
};

// -----------------------------
// Download CSV
// -----------------------------
const downloadPincode = async (req, res) => {
  try {
    const { courier } = req.params;
    const courierData = await CourierPincodeB2B.findOne({ courier });
    if (!courierData)
      return res
        .status(404)
        .json({ message: "No pincodes found for this courier" });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=serviceable_pincodes_${courier}.csv`
    );

    const csvStream = csv.format({ headers: true });
    csvStream.pipe(res);

    courierData.pincodes.forEach((p) => {
      csvStream.write({
        Pincode: p.pincode,
        Pickup: p.pickup ? "Y" : "N",
        Delivery: p.delivery ? "Y" : "N",
        Cod: p.cod ? "Y" : "N",
      });
    });

    csvStream.end();
  } catch (err) {
    console.error("Error in downloadPincode:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

const getShiprocketCourierServices = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: [
      {
        service: ["Bluedart-surface"],
      },
      {
        service: ["Delhivery-surface"],
      },
      {
        service: ["Delhivery Heavy-surface"],
      },
      {
        service: ["Gati-surface"],
      },
      {
        service: ["Xpressbees-surface"],
      },
      {
        service: ["VXpress-surface"],
      },
      {
        service: ["DP World-surface"],
      },
      {
        service: ["Movin-air"],
      },
      {
        service: ["Movin-surface"],
      },
      {
        service: ["Smart Cargo Advantage-surface"],
      },
    ],
  });
};

module.exports = {
  getAllCouriers,
  getAllCourierServices,
  createCourier,
  updateCourierServicesStatus,
  updateCourier,
  deleteCourier,
  updateCourierStatus,
  uploadPincode,
  downloadPincode,
  loadCourierPincodes,
  getShiprocketCourierServices,
};
