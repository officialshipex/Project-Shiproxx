const express = require("express");
const router = express.Router();
const { isAuthorized } = require("../middleware/auth.middleware");
const { uploads } = require("../config/s3");
const {
  uploadAgreement,
  getAdminAgreements,
  getUserAgreements,
  markAsRead,
  acceptAgreement,
  getPendingAgreements,
  previewAgreement,
  downloadAgreement,
} = require("./agreement.controller");

// Admin routes
router.post(
  "/admin/upload",
  isAuthorized,
  uploads.single("agreementFile"),
  uploadAgreement
);
router.get("/admin/list", isAuthorized, getAdminAgreements);

// User routes
router.get("/user/list", isAuthorized, getUserAgreements);
router.get("/user/read/:agreementId", isAuthorized, markAsRead);
router.get("/user/accept/:agreementId", isAuthorized, acceptAgreement);
router.get("/user/pending", isAuthorized, getPendingAgreements);
router.get("/user/preview/:agreementId", isAuthorized, previewAgreement);
router.get("/user/download/:agreementId", isAuthorized, downloadAgreement);

module.exports = router;
