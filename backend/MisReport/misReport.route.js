const express = require("express");
const router = express.Router();
const controller = require("./misReport.controller");

router.post("/generate", controller.generateMisReport);
router.get("/list", controller.listMisReports);

module.exports = router;
