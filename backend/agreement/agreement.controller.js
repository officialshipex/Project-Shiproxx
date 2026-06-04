const fs = require("fs");
const path = require("path");
const Agreement = require("../models/Agreement.model");
const UserAgreement = require("../models/UserAgreement.model");
const User = require("../models/User.model");
const Kyc = require("../models/Kyc.model");
const Kyc2 = require("../models/Kyc2.model");
const Pan = require("../models/Pan.model");
const Gstin = require("../models/Gstin.model");
const Aadhaar = require("../models/Aadhaar.model");

// Admin: Upload new agreement
const uploadAgreement = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const { versionName } = req.body;
    if (!versionName) {
      return res.status(400).json({ success: false, message: "Version name is required" });
    }

    const agreement = await Agreement.create({
      fileName: req.file.originalname,
      versionName,
      fileUrl: req.file.location,
    });

    // Reset all users' read/accept status for new agreement
    // Create UserAgreement records with isRead=false, isAccepted=false for all users
    const users = await User.find({}, { _id: 1 });
    const userAgreements = users.map((u) => ({
      user: u._id,
      agreement: agreement._id,
      isRead: false,
      isAccepted: false,
    }));

    if (userAgreements.length > 0) {
      await UserAgreement.insertMany(userAgreements);
    }

    res.status(201).json({
      success: true,
      message: "Agreement uploaded successfully",
      agreement,
    });
  } catch (error) {
    console.error("Upload agreement error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Admin: Get all agreements
const getAdminAgreements = async (req, res) => {
  try {
    const agreements = await Agreement.find().sort({ createdAt: -1 });
    res.json({ success: true, agreements });
  } catch (error) {
    console.error("Get agreements error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// User: Get all agreements with read/accept status
const getUserAgreements = async (req, res) => {
  try {
    const userId = req.user._id;

    const agreements = await Agreement.find().sort({ createdAt: -1 });

    const userAgreements = await UserAgreement.find({ user: userId });

    const userAgreementMap = {};
    userAgreements.forEach((ua) => {
      userAgreementMap[ua.agreement.toString()] = ua;
    });

    const data = agreements.map((ag) => {
      const ua = userAgreementMap[ag._id.toString()];
      return {
        _id: ag._id,
        fileName: ag.fileName,
        versionName: ag.versionName,
        fileUrl: ag.fileUrl,
        createdAt: ag.createdAt,
        isRead: ua ? ua.isRead : false,
        isAccepted: ua ? ua.isAccepted : false,
        readAt: ua ? ua.readAt : null,
        acceptedAt: ua ? ua.acceptedAt : null,
      };
    });

    res.json({ success: true, agreements: data });
  } catch (error) {
    console.error("Get user agreements error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// User: Mark agreement as read
const markAsRead = async (req, res) => {
  try {
    const userId = req.user._id;
    const { agreementId } = req.params;

    let userAgreement = await UserAgreement.findOne({
      user: userId,
      agreement: agreementId,
    });

    if (!userAgreement) {
      userAgreement = await UserAgreement.create({
        user: userId,
        agreement: agreementId,
        isRead: true,
        readAt: new Date(),
      });
    } else {
      userAgreement.isRead = true;
      userAgreement.readAt = new Date();
      await userAgreement.save();
    }

    res.json({ success: true, message: "Marked as read" });
  } catch (error) {
    console.error("Mark as read error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// User: Accept agreement
const acceptAgreement = async (req, res) => {
  try {
    const userId = req.user._id;
    const { agreementId } = req.params;

    let userAgreement = await UserAgreement.findOne({
      user: userId,
      agreement: agreementId,
    });

    if (!userAgreement) {
      return res.status(404).json({ success: false, message: "Agreement not found" });
    }

    if (!userAgreement.isRead) {
      return res.status(400).json({
        success: false,
        message: "Please read the agreement before accepting",
      });
    }

    userAgreement.isAccepted = true;
    userAgreement.acceptedAt = new Date();
    await userAgreement.save();

    res.json({ success: true, message: "Agreement accepted" });
  } catch (error) {
    console.error("Accept agreement error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// User: Check for pending (unread) agreements
const getPendingAgreements = async (req, res) => {
  try {
    const userId = req.user._id;

    const agreements = await Agreement.find().sort({ createdAt: -1 });

    if (agreements.length === 0) {
      return res.json({ success: true, hasPending: false, agreements: [] });
    }

    const latestAgreement = agreements[0];

    const userAgreement = await UserAgreement.findOne({
      user: userId,
      agreement: latestAgreement._id,
    });

    const hasPending = !userAgreement || !userAgreement.isAccepted;

    res.json({
      success: true,
      hasPending,
      agreement: {
        _id: latestAgreement._id,
        versionName: latestAgreement.versionName,
        createdAt: latestAgreement.createdAt,
        isRead: userAgreement ? userAgreement.isRead : false,
        isAccepted: userAgreement ? userAgreement.isAccepted : false,
      },
    });
  } catch (error) {
    console.error("Get pending agreements error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// User: Preview dynamic agreement with seller details
const previewAgreement = async (req, res) => {
  try {
    const userId = req.user._id;
    const { agreementId } = req.params;

    const agreement = await Agreement.findById(agreementId);
    if (!agreement) {
      return res.status(404).json({ success: false, message: "Agreement not found" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const kyc = await Kyc.findOne({ user: userId });
    const kyc2 = await Kyc2.findOne({ user: userId });
    const panDoc = await Pan.findOne({ user: userId });
    const gstinDoc = await Gstin.findOne({ user: userId });
    const aadhaarDoc = await Aadhaar.findOne({ user: userId });

    const category = kyc?.companyCategory || kyc2?.companyCategory || "individual";
    const hasGst = !!(kyc?.gstNumber || kyc2?.gstNumber || gstinDoc?.gstin);
    const hasPan = !!(kyc?.panNumber || kyc2?.panNumber || panDoc?.pan);

    const aadhaarName = aadhaarDoc?.name || "";
    const aadhaarAddress = aadhaarDoc
      ? [aadhaarDoc.address, aadhaarDoc.city, aadhaarDoc.state].filter(Boolean).join(", ")
      : "";

    const displayName =
      kyc2?.companyDetails?.sellerName ||
      kyc?.panName ||
      kyc2?.panHolderName ||
      aadhaarName ||
      user.fullname ||
      "";

    const companyName =
      kyc?.companyName ||
      kyc2?.companyDetails?.companyName ||
      kyc2?.gstCompanyName ||
      gstinDoc?.nameOfBusiness ||
      gstinDoc?.legalNameOfBusiness ||
      user.company ||
      "";

    const gstNumber = kyc?.gstNumber || kyc2?.gstNumber || gstinDoc?.gstin || "";
    const panNumber = kyc?.panNumber || kyc2?.panNumber || panDoc?.pan || "";

    let companyAddress = "";
    if (hasGst) {
      const addr = kyc?.gstNumber && kyc?.address ? kyc.address : null;
      const addr2 = kyc2?.gstNumber && kyc2?.primaryAddress ? kyc2.primaryAddress : null;
      const source = addr || addr2;
      if (source) {
        companyAddress = [
          source.addressLine1 || source.addressLineOne || "",
          source.addressLine2 || source.addressLineTwo || "",
          source.city || "",
          source.state || "",
          source.pincode || source.pinCode || "",
        ]
          .filter(Boolean)
          .join(", ");
      } else if (gstinDoc?.gstin) {
        companyAddress = [
          gstinDoc.address || "",
          gstinDoc.city || "",
          gstinDoc.state || "",
          gstinDoc.pincode ? String(gstinDoc.pincode) : "",
        ]
          .filter(Boolean)
          .join(", ");
      }
    } else if (aadhaarAddress) {
      companyAddress = aadhaarAddress;
    }

    // --- Append GSTIN or PAN to address ---
    if (hasGst) {
      if (companyAddress) companyAddress += `, [GSTIN: ${gstNumber}]`;
      else companyAddress = `[GSTIN: ${gstNumber}]`;
    } else if (hasPan) {
      if (companyAddress) companyAddress += `, [PAN: ${panNumber}]`;
      else companyAddress = `[PAN: ${panNumber}]`;
    }

    const date = new Date().toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    // --- Build seller business type description ---
    let businessTypeDesc = "";
    if (category === "company") {
      businessTypeDesc = "Company incorporated under the provisions of Companies Act, 2013";
    } else {
      businessTypeDesc = "Sole Proprietorship Firm";
    }

    // --- Build the seller party name ---
    let sellerPartyName = hasGst ? (companyName || displayName) : (aadhaarName || displayName);

    // --- Build the intro paragraph ---
    const introParagraph = `This Merchant Agreement is executed on the signing date/acceptance date by and between,

Quickpost360 Services Private Limited, [CIN:U53200HR2025PTC138342] a company incorporated under the provisions of the Companies Act, 2013, and having its registered office at House Number 87 Singhal Panna, Gali Number 2, Near Shiv Mandir, Badesra, Bhiwani, Haryana, India, 127031, legally represented by its authorized signatory (hereinafter referred to as "Company" or "Service Provider" or "QUICKPOST"), which means and include, unless repugnant to the context or meaning thereof its legal agents, contractors, sub-contractors, affiliates, employees, receivers and assigns of ONE PART;

-and-

${sellerPartyName} ${businessTypeDesc}, having its Office/Registered Office at ${companyAddress || "N/A"}, legally represented by its authorised signatory Mr/Mrs. ${displayName} (hereinafter referred to as "Customer/Seller/User"), which means and include, unless repugnant to the context or meaning thereof mean and include its legal agents, contractors, sub-contractors, affiliates, employees affiliates, assign, liquidators, successors and permitted assigns of the OTHER PART.`;

    // --- Load template and replace placeholders ---
    const templatePath = path.join(__dirname, "template.html");
    let html = fs.readFileSync(templatePath, "utf8");

    html = html.replace("{{introParagraph}}", introParagraph.replace(/\n/g, "<br>"));

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    console.error("Preview agreement error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// User: Download dynamic agreement as HTML file
const downloadAgreement = async (req, res) => {
  try {
    const userId = req.user._id;
    const { agreementId } = req.params;

    const agreement = await Agreement.findById(agreementId);
    if (!agreement) {
      return res.status(404).json({ success: false, message: "Agreement not found" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const kyc = await Kyc.findOne({ user: userId });
    const kyc2 = await Kyc2.findOne({ user: userId });
    const panDoc = await Pan.findOne({ user: userId });
    const gstinDoc = await Gstin.findOne({ user: userId });
    const aadhaarDoc = await Aadhaar.findOne({ user: userId });

    const category = kyc?.companyCategory || kyc2?.companyCategory || "individual";
    const hasGst = !!(kyc?.gstNumber || kyc2?.gstNumber || gstinDoc?.gstin);
    const hasPan = !!(kyc?.panNumber || kyc2?.panNumber || panDoc?.pan);

    const aadhaarName = aadhaarDoc?.name || "";
    const aadhaarAddress = aadhaarDoc
      ? [aadhaarDoc.address, aadhaarDoc.city, aadhaarDoc.state].filter(Boolean).join(", ")
      : "";

    const displayName =
      kyc2?.companyDetails?.sellerName ||
      kyc?.panName ||
      kyc2?.panHolderName ||
      aadhaarName ||
      user.fullname ||
      "";

    const companyName =
      kyc?.companyName ||
      kyc2?.companyDetails?.companyName ||
      kyc2?.gstCompanyName ||
      gstinDoc?.nameOfBusiness ||
      gstinDoc?.legalNameOfBusiness ||
      user.company ||
      "";

    const gstNumber = kyc?.gstNumber || kyc2?.gstNumber || gstinDoc?.gstin || "";
    const panNumber = kyc?.panNumber || kyc2?.panNumber || panDoc?.pan || "";

    let companyAddress = "";
    if (hasGst) {
      const addr = kyc?.gstNumber && kyc?.address ? kyc.address : null;
      const addr2 = kyc2?.gstNumber && kyc2?.primaryAddress ? kyc2.primaryAddress : null;
      const source = addr || addr2;
      if (source) {
        companyAddress = [
          source.addressLine1 || source.addressLineOne || "",
          source.addressLine2 || source.addressLineTwo || "",
          source.city || "",
          source.state || "",
          source.pincode || source.pinCode || "",
        ]
          .filter(Boolean)
          .join(", ");
      } else if (gstinDoc?.gstin) {
        companyAddress = [
          gstinDoc.address || "",
          gstinDoc.city || "",
          gstinDoc.state || "",
          gstinDoc.pincode ? String(gstinDoc.pincode) : "",
        ]
          .filter(Boolean)
          .join(", ");
      }
    } else if (aadhaarAddress) {
      companyAddress = aadhaarAddress;
    }

    if (hasGst) {
      if (companyAddress) companyAddress += `, [GSTIN: ${gstNumber}]`;
      else companyAddress = `[GSTIN: ${gstNumber}]`;
    } else if (hasPan) {
      if (companyAddress) companyAddress += `, [PAN: ${panNumber}]`;
      else companyAddress = `[PAN: ${panNumber}]`;
    }

    let businessTypeDesc = "";
    if (category === "company") {
      businessTypeDesc = "Company incorporated under the provisions of Companies Act, 2013";
    } else {
      businessTypeDesc = "Sole Proprietorship Firm";
    }

    let sellerPartyName = hasGst ? (companyName || displayName) : (aadhaarName || displayName);

    const introParagraph = `This Merchant Agreement is executed on the signing date/acceptance date by and between,

Quickpost360 Services Private Limited, [CIN:U53200HR2025PTC138342] a company incorporated under the provisions of the Companies Act, 2013, and having its registered office at House Number 87 Singhal Panna, Gali Number 2, Near Shiv Mandir, Badesra, Bhiwani, Haryana, India, 127031, legally represented by its authorized signatory (hereinafter referred to as "Company" or "Service Provider" or "QUICKPOST"), which means and include, unless repugnant to the context or meaning thereof its legal agents, contractors, sub-contractors, affiliates, employees, receivers and assigns of ONE PART;

-and-

${sellerPartyName} ${businessTypeDesc}, having its Office/Registered Office at ${companyAddress || "N/A"}, legally represented by its authorised signatory Mr/Mrs. ${displayName} (hereinafter referred to as "Customer/Seller/User"), which means and include, unless repugnant to the context or meaning thereof mean and include its legal agents, contractors, sub-contractors, affiliates, employees affiliates, assign, liquidators, successors and permitted assigns of the OTHER PART.`;

    const templatePath = path.join(__dirname, "template.html");
    let html = fs.readFileSync(templatePath, "utf8");

    html = html.replace("{{introParagraph}}", introParagraph.replace(/\n/g, "<br>"));

    const filename = `Quickpost360_Agreement_${agreement.versionName.replace(/\s+/g, "_")}.html`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(html);
  } catch (error) {
    console.error("Download agreement error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  uploadAgreement,
  getAdminAgreements,
  getUserAgreements,
  markAsRead,
  acceptAgreement,
  getPendingAgreements,
  previewAgreement,
  downloadAgreement,
};
