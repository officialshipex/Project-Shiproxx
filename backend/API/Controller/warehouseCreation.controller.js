const pickAddress = require("../../models/pickupAddress.model");
const createPickupAddress = async (req, res) => {
  try {
    const { contactName, email, phoneNumber, address, pinCode, city, state } =
      req.body;

    // === Field Validation ===
    const missingFields = [];
    if (!contactName) missingFields.push("contactName");
    if (!phoneNumber) missingFields.push("phoneNumber");
    if (!address) missingFields.push("address");
    if (!pinCode) missingFields.push("pinCode");
    if (!city) missingFields.push("city");
    if (!state) missingFields.push("state");

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: "Validation Error: Missing required fields.",
        missingFields,
        timestamp: new Date().toISOString(),
      });
    }

    // === Email Validation (only if provided, since email is optional) ===
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email && !emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: "Invalid email format.",
        timestamp: new Date().toISOString(),
      });
    }

    // === Phone Number Validation ===
    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: "Invalid phone number. Must be 10 digits.",
        timestamp: new Date().toISOString(),
      });
    }

    // === Pin Code Validation ===
    const pinRegex = /^[0-9]{6}$/;
    if (!pinRegex.test(pinCode)) {
      return res.status(400).json({
        success: false,
        code: 400,
        message: "Invalid pin code. Must be 6 digits.",
        timestamp: new Date().toISOString(),
      });
    }

    // === Check for Duplicate Address ===
    const userId = req.user?._id || null;
    const existingAddress = await pickAddress.findOne({
      userId,
      "pickupAddress.contactName": contactName,
      "pickupAddress.email": email,
      "pickupAddress.phoneNumber": phoneNumber,
      "pickupAddress.address": address,
      "pickupAddress.pinCode": pinCode,
      "pickupAddress.city": city,
      "pickupAddress.state": state,
    });

    if (existingAddress) {
      return res.status(409).json({
        success: false,
        code: 409,
        message:
          "Duplicate address detected. This pickup address already exists.",
        timestamp: new Date().toISOString(),
      });
    }

    // === Create and Save Pickup Address ===
    const newAddress = new pickAddress({
      userId,
      pickupAddress: {
        contactName,
        email,
        phoneNumber,
        address,
        pinCode,
        city,
        state,
      },
    });

    await newAddress.save();

    // === Success Response ===
    return res.status(201).json({
      success: true,
      code: 201,
      message: "Pickup address saved successfully.",
      data: {
        id: newAddress._id,
        ...newAddress.pickupAddress.toObject(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Error creating pickup address:", error);
    return res.status(500).json({
      success: false,
      code: 500,
      message: "Internal Server Error while saving pickup address.",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};

module.exports = createPickupAddress;
