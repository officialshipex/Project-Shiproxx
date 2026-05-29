const { AxiosError } = require("axios");
const express = require("express");
const dotenv = require("dotenv");
const axios = require("axios");
const crypto = require("crypto");

const {
  getSignature,
  validateGST,
  validatePAN,
  validateAadhaar,
  validateBankDetails,
  validateAccountNumber,
} = require("../utils/lib");
const BankAccount = require("../models/BankAccount.model");
const Aadhaar = require("../models/Aadhaar.model");
const Gstin = require("../models/Gstin.model");
const User = require("../models/User.model");
const Pan = require("../models/Pan.model");
const Kyc = require("../models/Kyc.model");
const BilingInfo = require("../models/billingInfo.model");

dotenv.config();
const verfication = express.Router();
const cashfreeUrl = process.env.CASHFREE_URI;

/**
 * verify GSTIN number
 */
verfication.post("/gstin", async (req, res) => {
  try {
    const userId = req.user._id;
    // console.log("userId:", userId);
    const { GSTIN, businessName } = req.body;
    // console.log("GSTIN:", GSTIN);
    if (!GSTIN) {
      return res.status(400).json({
        success: false,
        message: "GSTIN is required",
      });
    }

    const validateGstin = validateGST(GSTIN);

    if (!validateGstin) {
      return res.status(400).json({
        success: false,
        message: "Invalid GSTIN",
      });
    }

    const gstinExists = await Gstin.findOne({ gstin: GSTIN });

    // console.log("gstinExists:", gstinExists.user);

    if (gstinExists) {
      if (!gstinExists.user.equals(userId)) {
        return res.status(400).json({
          success: false,
          message: "gstin already exists for another user",
        });
      }
      return res.status(200).json({
        success: true,
        message: "GSTIN already exists",
        data: gstinExists,
      });
    }

    const data = JSON.stringify({
      GSTIN: GSTIN,
      businessName: businessName || "",
    });

    let signature = getSignature();
    console.log(signature);

    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: `${cashfreeUrl}/gstin`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": process.env.X_CLIENT_ID,
        "x-client-secret": process.env.X_CLIENT_SECRET,
        "x-cf-signature": signature,
        "x-api-version": "2022-10-26",
      },
      data: data,
    };

    const response = await axios.request(config);

    console.log(response.data);

    if (!response || !response.data) {
      return res.status(500).json({
        success: false,
        message: "Internal error",
      });
    }

    if (response.data.message !== "GSTIN Exists") {
      return res.status(response.status).json({
        success: false,
        message: response.data.message,
      });
    }

    const newGstin = new Gstin({
      user: userId,
      gstin: response.data.GSTIN,
      nameOfBusiness: response.data.trade_name_of_business || response.data.legal_name_of_business,
      referenceId: response.data.reference_id,
      legalNameOfBusiness: response.data.legal_name_of_business,
      taxPayerType: response.data.taxpayer_type,
      gstInStatus: response.data.gst_in_status,
      dateOfRegistration: response.data.date_of_registration,
      address: response.data.principal_place_address,
      city: response.data.principal_place_split_address.location,
      state: response.data.principal_place_split_address.state,
      pincode: response.data.principal_place_split_address.pincode,
    });

    await newGstin.save();

    // console.log("newGstin:", newGstin);

    return res.status(200).json({
      success: true,
      message: "GSTIN verified successfully",
      data: newGstin,
    });
  } catch (err) {
    console.log("err:", err);

    if (err.isAxiosError && err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        message: err.response.data.message || "Error in GSTIN verification",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});


async function verifyGstin(gstin, businessName = "") {
  try {
    if (!gstin) {
      console.log("GSTIN is required");
      return;
    }

    const validateGstin = validateGST(gstin);

    if (!validateGstin) {
      console.log("Invalid GSTIN");
      return;
    }

    const data = JSON.stringify({
      GSTIN: gstin,
      businessName: businessName || "",
    });

    const signature = getSignature();

    const config = {
      method: "post",
      maxBodyLength: Infinity,
      url: `${cashfreeUrl}/gstin`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": process.env.X_CLIENT_ID,
        "x-client-secret": process.env.X_CLIENT_SECRET,
        "x-cf-signature": signature,
        "x-api-version": "2022-10-26",
      },
      data: data,
    };

    const response = await axios.request(config);

    console.log("GSTIN API Response:");
    console.log(response.data);

    return response.data;
  } catch (err) {
    if (err.isAxiosError && err.response) {
      console.log("API Error:", err.response.data);
    } else {
      console.log("Internal Error:", err.message);
    }
  }
}

// verifyGstin("33HPZPK7732E1ZC");

/**
 * verify Pan number
 */
verfication.post("/pan", async (req, res) => {
  try {
    const userId = req.user._id;
    const { pan, name } = req.body;
    // console.log(pan);
    if (!pan) {
      return res.status(400).json({
        success: false,
        message: "pan  is required",
      });
    }

    const validatePan = validatePAN(pan);

    if (!validatePan) {
      return res.status(400).json({
        success: false,
        message: "Invalid pan",
      });
    }

    const panExists = await Pan.findOne({ pan });

    if (panExists) {
      if (!panExists.user.equals(userId)) {
        return res.status(400).json({
          success: false,
          message: "Pan already exists for another user",
        });
      }
      return res.status(200).json({
        success: true,
        message: "Pan already exists",
        data: panExists,
      });
    }

    const data = JSON.stringify({
      pan: pan,
      name: name || "",
    });

    let signature = getSignature();
    // console.log(signature);

    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: `${cashfreeUrl}/pan`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": process.env.X_CLIENT_ID,
        "x-client-secret": process.env.X_CLIENT_SECRET,
        "x-cf-signature": signature,
        "x-api-version": "2024-10-18",
      },
      data: data,
    };

    const response = await axios.request(config);

    // console.log("response:", response);

    if (!response || !response.data) {
      return res.status(500).json({
        success: false,
        message: "Internal error",
      });
    }

    if (!response.data.valid) {
      return res.status(400).json({
        success: false,
        pan: response.data.pan,
        reference_id: response.data.reference_id,
        name_provided: response.data.name_pan_card,
        valid: response.data.valid,
        message: response.data.message,
      });
    }

    const newPan = new Pan({
      user: userId,
      nameProvided: response.data.name_pan_card,
      pan: response.data.pan,
      registeredName: response.data.registered_name,
      panType: response.data.type,
      panRefId: response.data.reference_id,
    });

    await newPan.save();

    // console.log("newPan:", newPan);

    return res.status(200).json({
      success: true,
      message: "Pan verified successfully",
      data: newPan,
    });
  } catch (err) {
    console.log("err:", err);

    if (err.isAxiosError && err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        message: err.response.data.message || "Error in Pan verification",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/**
 * verify Aadhaar number, here we send the otp to the user's mobile number
 */
verfication.post("/generate-otp", async (req, res) => {
  try {
    const userId = req.user._id;
    // const userId = "6711f5f10d7b30f7193c55fd";
    const { aadhaarNo } = req.body;

    if (!aadhaarNo) {
      return res.status(400).json({
        success: false,
        message: "Aadhaar number is required",
      });
    }

    const validateField = validateAadhaar(aadhaarNo);

    if (!validateField) {
      return res.status(400).json({
        success: false,
        message: "Invalid Aadhaar number",
      });
    }

    const aadhaarExists = await Aadhaar.findOne({ aadhaarNumber: aadhaarNo });

    if (aadhaarExists) {
      if (!aadhaarExists.user.equals(userId)) {
        return res.status(400).json({
          success: false,
          message: "Aadhaar already exists for another user",
        });
      }
      return res.status(200).json({
        success: true,
        message: "Aadhaar already exists",
        data: aadhaarExists,
      });
    }

    const data = JSON.stringify({
      aadhaar_number: aadhaarNo,
    });

    let signature = getSignature();

    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: `${cashfreeUrl}/offline-aadhaar/otp`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": process.env.X_CLIENT_ID,
        "x-client-secret": process.env.X_CLIENT_SECRET,
        "x-cf-signature": signature,
        "x-api-version": "2024-10-18",
      },
      data: data,
    };

    const response = await axios.request(config);
    // console.log("response : ", response);

    if (response.data.status !== "SUCCESS") {
      return res
        .status(200)
        .json({ success: false, message: response.data.message });
    }

    // console.log("response:", response);

    return res.status(200).json({
      success: true,
      message: response.data.message,
      data: response.data,
    });
  } catch (err) {
    // console.log("err:", err);

    if (err.isAxiosError && err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        message: err.response.data.message || "Error in Aadhaar verification",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/**
 * verify otp for Aadhaar number
 */
verfication.post("/verify-otp", async (req, res) => {
  try {
    const userId = req.user._id;
    // const userId = "6711f5f10d7b30f7193c55fd";
    const { otp, refId, aadhaarNo } = req.body;
    // console.log(req.body);
    if (!otp || !refId) {
      return res.status(400).json({
        success: false,
        message: "invalid is required",
      });
    }

    const data = JSON.stringify({
      otp: otp,
      ref_id: refId,
    });
    // console.log("data",data)

    let signature = getSignature();

    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: `${cashfreeUrl}/offline-aadhaar/verify`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": process.env.X_CLIENT_ID,
        "x-client-secret": process.env.X_CLIENT_SECRET,
        "x-cf-signature": signature,
        "x-api-version": "2024-10-18",
      },
      data: data,
    };

    const response = await axios.request(config);

    console.log("response:", response.data);

    const newAadhaar = new Aadhaar({
      user: userId,
      aadhaarNumber: aadhaarNo,
      status: response.data.status,
      sonOf: response?.data?.care_of || "N/A",
      dob: response.data.dob,
      email: response.data.email,
      gender: response.data.gender,
      address: response.data.address,
      name: response.data.name,
      state: response.data.split_address.state,
      city: response.data.split_address.dist,
    });

    await newAadhaar.save();

    return res.status(200).json({
      success: true,
      data: newAadhaar,
    });
  } catch (err) {
    console.log("err:", err);

    if (err.isAxiosError && err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        message: err.response.data.message || "Error in Aadhaar verification",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/**
 * verify bank account
 */
verfication.post("/bank-account", async (req, res) => {
  try {
    // let userId = req.user._id;
    let userId;
    if (req.query.id) {
      userId = req.query.id;
    } else {
      userId = req.user._id;
    }
    // const userId = "6711f5f10d7b30f7193c55fd";

    const { accountNo, ifsc } = req.body;
    // console.log(req.body);

    if (!accountNo || !ifsc) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }
    // 🔹 Check if the same bank account number exists for another user
    const accountExistsForAnotherUser = await BankAccount.findOne({
      accountNumber: accountNo,
      user: { $ne: userId },
    });

    if (accountExistsForAnotherUser) {
      return res.status(400).json({
        success: false,
        message: "This bank account is already linked to another user",
      });
    }

    // 🔹 Check if bank details already exist for this user
    let existingBankAccount = await BankAccount.findOne({ user: userId });
    // 🔹 If same details exist, skip everything
    if (
      existingBankAccount &&
      existingBankAccount.accountNumber === accountNo &&
      existingBankAccount.ifsc === ifsc
    ) {
      return res.status(400).json({
        success: true,
        message: "Bank Account already exists",
        data: existingBankAccount,
      });
    }
    // 🔹 Call Cashfree verification API
    const data = JSON.stringify({
      bank_account: accountNo,
      ifsc: ifsc,
    });
    console.log(data);
    let signature = getSignature();

    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: `${cashfreeUrl}/bank-account/sync`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-id": process.env.X_CLIENT_ID,
        "x-client-secret": process.env.X_CLIENT_SECRET,
        "x-cf-signature": signature,
        "x-api-version": "2024-10-18",
      },
      data: data,
    };

    const response = await axios.request(config);
    console.log("bank account", response.data);

    if (response.data.account_status === "INVALID") {
      return res.status(400).json({
        success: false,
        message: response.data.account_status_code,
      });
    }

    if (existingBankAccount) {
      // 🔹 Update existing bank details
      existingBankAccount.accountNumber = accountNo;
      existingBankAccount.ifsc = ifsc;
      existingBankAccount.AccountStatus = response.data.account_status;
      existingBankAccount.nameAtBank = response.data.name_at_bank;
      existingBankAccount.bank = response.data.bank_name;
      existingBankAccount.branch = response.data.branch;
      existingBankAccount.city = response.data.city;
      existingBankAccount.nameMatchResult = response.data.name_match_result;

      await existingBankAccount.save();

      return res.status(200).json({
        success: true,
        message: "Bank Account updated successfully",
        data: existingBankAccount,
      });
    } else {
      // 🔹 Create new bank account
      const newBankAccount = new BankAccount({
        user: userId,
        accountNumber: accountNo,
        ifsc: ifsc,
        AccountStatus: response.data.account_status,
        nameAtBank: response.data.name_at_bank,
        bank: response.data.bank_name,
        branch: response.data.branch,
        city: response.data.city,
        nameMatchResult: response.data.name_match_result,
      });

      await newBankAccount.save();

      return res.status(200).json({
        success: true,
        message: "Bank Account verified successfully",
        data: newBankAccount,
      });
    }
  } catch (err) {
    console.log("err:", err);

    if (err.isAxiosError && err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        message:
          err.response.data.message || "Error in Bank Account verification",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

verfication.post("/billing-info", async (req, res) => {
  try {
    const userId = req.user._id;
    const { address, city, state, postalCode } = req.body.billingInfo;

    //  console.log(billingInfo)
    // console.log(address,city,state,postalCode)

    if (!address || !city || !state || !postalCode) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const billing = new BilingInfo({
      user: userId,
      address,
      city,
      state,
      postalCode,
    });

    await billing.save();

    return res.status(200).json({
      success: true,
      message: "Billing Info saved successfully",
      data: billing,
    });
  } catch (err) {
    // console.log("err:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

verfication.post("/kyc", async (req, res) => {
  try {
    console.log("Received KYC request:", req.body);

    const userId = req.user?._id;
    if (!userId) {
      return res
        .status(401)
        .json({ success: false, message: "User not authenticated" });
    }

    const companyCategory = req.body?.payload?.selectedType || null;
    const aadhaarNumber = req.body?.payload?.documentDetails?.aadharNo || null;
    const gstNumber = req.body?.payload?.gstNumber || null;
    const panNumber = req.body?.payload?.documentDetails?.pan || null;
    const isVerified = req.body?.payload?.isVerified || false;
    const panHolderName = req.body?.payload?.documentDetails?.panName || null;
    const ifscCode = req.body?.payload?.bankDetails?.ifsc || null;
    const accountNumber = req.body?.payload?.bankDetails?.accountNumber || null;

    // ❌ Prevent inserting null Aadhaar numbers
    if (!aadhaarNumber) {
      return res
        .status(400)
        .json({ success: false, message: "Aadhaar Number is required" });
    }

    if (
      !companyCategory ||
      !panNumber ||
      !panHolderName ||
      !accountNumber ||
      !ifscCode ||
      !isVerified
    ) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required" });
    }

    if (!validatePAN(panNumber)) {
      console.log("Invalid PAN:", panNumber);
      return res
        .status(400)
        .json({ success: false, message: "Invalid PAN number" });
    }

    if (!validateBankDetails(accountNumber, ifscCode)) {
      console.log("Invalid Bank Details:", accountNumber, ifscCode);
      return res
        .status(400)
        .json({ success: false, message: "Invalid bank details" });
    }

    const kycExists = await Kyc.findOne({ user: userId });
    if (kycExists) {
      const data = await Kyc.findByIdAndUpdate(
        kycExists._id,
        {
          companyCategory,
          gstNumber,
          panNumber,
          panHolderName,
          accountNumber,
          ifscCode,
          isVerified,
        },
        { new: true, runValidators: true }
      ).lean();

      await User.findByIdAndUpdate(userId, { kycDone: true, isVerified: true });

      return res
        .status(200)
        .json({ success: true, message: "KYC Updated successfully", data });
    }

    const newKyc = new Kyc({
      user: userId,
      companyCategory,
      gstNumber,
      panNumber,
      panHolderName,
      accountNumber,
      ifscCode,
      isVerified,
    });
    // await newKyc.save();

    await User.findByIdAndUpdate(userId, { kycDone: true, isVerified: true });

    return res.status(200).json({
      success: true,
      message: "KYC verified successfully",
      data: newKyc,
    });
  } catch (err) {
    console.error("Error in KYC Submission:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: err.message,
    });
  }
});

verfication.get("/kyc", async (req, res) => {
  try {
    const userId = req.user._id;

    const kyc = await Kyc.findOne({ user: userId });

    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: kyc,
    });
  } catch (err) {
    // console.log("err:", err);
    if (err.isAxiosError && err.response) {
      return res.status(err.response.status || 500).json({
        success: false,
        message: err.response.data.message || "Error in getting KYC",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

verfication.get("/kyc2", async (req, res) => {
  try {
    const userId = req.user._id;

    const kyc = await Kyc2Model.findOne({ user: userId });
    // console.log("kyc:", kyc);

    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "KYC not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: kyc,
    });
  } catch (err) {
    // console.log("err:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

verfication.post("/updateAadhaar", async (req, res) => {
  try {
    const {
      aadhaarNumber,
      name,
      address,
      state,
      city,
      status,
      sonOf,
      dob,
      email,
      gender,
    } = req.body;
    const { id } = req.query; // user ID from query

    if (!id || !aadhaarNumber) {
      return res.status(400).json({
        success: false,
        message: "User ID and Aadhaar number are required.",
      });
    }

    // Use empty string for missing fields
    const aadhaarData = {
      user: id,
      aadhaarNumber: aadhaarNumber || "",
      status: status || "",
      sonOf: sonOf || "",
      dob: dob || "",
      email: email || "",
      gender: gender || "",
      address: address || "",
      name: name || "",
      state: state || "",
      city: city || "",
    };

    // Check if Aadhaar already exists for this user
    let aadhaar = await Aadhaar.findOne({ user: id });

    if (aadhaar) {
      // Update existing record
      aadhaar = await Aadhaar.findOneAndUpdate(
        { user: id },
        { $set: aadhaarData },
        { new: true }
      );

      return res.status(200).json({
        success: true,
        message: "Aadhaar details updated successfully.",
        data: aadhaar,
      });
    } else {
      // Create new record
      const newAadhaar = new Aadhaar(aadhaarData);
      await newAadhaar.save();

      return res.status(201).json({
        success: true,
        message: "Aadhaar record created successfully.",
        data: newAadhaar,
      });
    }
  } catch (error) {
    console.error("Error updating Aadhaar:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while updating Aadhaar details.",
      error: error.message,
    });
  }
});

module.exports = verfication;
