const express = require("express");
const router = express.Router();
const { adminGetInvoices, userGetInvoices, scheduleMonthlyInvoiceCron, bulkDownloadInvoices, exportInvoiceToExcel, renameQPStoSFC } = require("./invoice.controller");
const { isAuthorized } = require("../middleware/auth.middleware");

// Admin route
router.get("/adminGetInvoices", isAuthorized, adminGetInvoices);

// User route
router.get("/userGetInvoices", isAuthorized, userGetInvoices);

router.get("/bulk-download", bulkDownloadInvoices);

router.get("/export-excel", exportInvoiceToExcel);

// One-time migration: rename QPS2627-* invoices to SFC2627-* (April & May 2026)
router.post("/rename-qps-to-sfc", isAuthorized, renameQPStoSFC);

module.exports = router;
