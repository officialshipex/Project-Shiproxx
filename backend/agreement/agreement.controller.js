const Agreement = require("../models/Agreement.model");
const UserAgreement = require("../models/UserAgreement.model");
const User = require("../models/User.model");

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

module.exports = {
  uploadAgreement,
  getAdminAgreements,
  getUserAgreements,
  markAsRead,
  acceptAgreement,
  getPendingAgreements,
};
