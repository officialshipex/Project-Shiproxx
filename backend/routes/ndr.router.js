const express = require('express');
const { ndrProcessController,ndrBulkProcessController } = require('../NDR/ndrProcess');

const router = express.Router();


router.post('/ndr-process', ndrProcessController);
router.post('/bulk',ndrBulkProcessController);

module.exports = router;
