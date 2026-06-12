const express = require("express");
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const codScheduleTask = require("./codScheduleTask.js");

const {
  codPlanUpdate,
  codRemittanceData,
  getCodRemitance,
  codRemittanceRecharge,
  getAdminCodRemitanceData,
  downloadSampleExcel,
  uploadCodRemittance,
  CheckCodplan,
  remittanceTransactionData,
  courierCodRemittance,
  CodRemittanceOrder,
  sellerremittanceTransactionData,
  CourierdownloadSampleExcel,
  uploadCourierCodRemittance,
  exportOrderInRemittance,
  validateCODTransfer,
  getCODTransferData,
  transferCOD,
  exportBankTemplate,
  uploadBankResponse,
  getBankExportBatches,
  validateExportedStatus,
  saveCustomCodPlan,
  correctRemittanceData,
  triggerCodJob,
} = require("./cod.controller");
const { isAuthorized } = require("../middleware/auth.middleware");
router.get("/getBankExportBatches", getBankExportBatches);
router.post("/validateExportedStatus", validateExportedStatus);
router.post("/codPlanUpdate", codPlanUpdate);
router.post("/saveCustomCodPlan", saveCustomCodPlan);
router.get("/codRemittanceData", codRemittanceData);
router.get("/getCodRemitance", getCodRemitance);
router.post("/codRemittanceRecharge", codRemittanceRecharge);
router.get("/getAdminCodRemitanceData", getAdminCodRemitanceData)
router.get("/download-excel", downloadSampleExcel)
router.get("/download-excel-courier", CourierdownloadSampleExcel)
router.post('/upload', upload.single('file'), uploadCodRemittance);
router.post('/upload_courier', upload.single('file'), uploadCourierCodRemittance);
router.get("/CheckCodplan", CheckCodplan)
router.get("/remittanceTransactionData/:id", remittanceTransactionData)
router.get("/sellerremittanceTransactionData/:id", sellerremittanceTransactionData)
router.get("/courierCodRemittance", courierCodRemittance)
router.get("/CodRemittanceOrder", CodRemittanceOrder)
router.get("/exportOrderInRemittance", exportOrderInRemittance)
router.post("/validateCODTransfer", validateCODTransfer)
router.get("/getCODTransferData/:id", getCODTransferData)
router.post("/transferCOD/:id", transferCOD)
router.get("/exportBankTemplate", exportBankTemplate)
router.post("/uploadBankResponse", uploadBankResponse)

// Admin-only: Correct a specific remittance entry based on actual order COD amounts
// ?dryRun=true will show the preview without making any changes
router.patch("/correctRemittanceData/:remittanceId", correctRemittanceData);

// Secure API trigger for background cron tasks
router.get("/trigger-job", triggerCodJob);

module.exports = router;