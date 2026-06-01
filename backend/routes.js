const express = require("express");
const router = express.Router();
const RTOCharges = require("./RTO/rtoController");
const authRouter = require("./routes/auth.router");
const { isAuthorized } = require("./middleware/auth.middleware");
const getKyc = require("./GetKycDetals/getKyc.router");
const paytmRoutes = require("./routes/paytm.router");
const verficationRouter = require("./routes/kyc.router");
const rechargeRouter = require("./recharge/recharge.route");
const weightDispreancy = require("./WeightDispreancy/weightDispreancy.route");

// const orderRouter = require("./routes/orders.router");

const userController = require("./routes/getUsers.router");
// const servicesController = require("./routes/getServices.router");
const calculateRouter = require("./routes/calculateRate.router");

const saveRateRouter = require("./routes/saveRate.router");
const getBaseRateController = require("./routes/getBaseRate.router");
const saveBaseRateController = require("./routes/saveBaseRate.router");
const customRateController = require("./routes/saveCustomRate.router");
// const editBaseRateController = require("./routes/editBaseRate.router");

const EcomExpressController = require("./AllCouriersRoutes/ecom.router");
const NimbusPostController = require("./AllCouriersRoutes/nimbuspost.router");
const ShipRocketController = require("./AllCouriersRoutes/shiprocket.router");
const XpressbeesController = require("./AllCouriersRoutes/xpressbee.router");
const shreeMarutiController = require("./AllCouriersRoutes/shreemaruti.router");
const SmartShipController = require("./AllCouriersRoutes/smartShip.router");
const DelhiveryController = require("./AllCouriersRoutes/delhivery.router");
const DtdcController = require("./AllCouriersRoutes/dtdc.router");
const AmazonRouter = require("./AllCouriersRoutes/amazon.router");
const Ekart = require("./AllCouriersRoutes/ekart.router");
const Vamaship = require("./AllCouriersRoutes/vamaship.router")
const LabelRouter = require("./label/label.router");
// const couriersB2CRoutes = require("./routes/couriersB2C.router");
// const courierServicesRoutes=require('./routes/courierServiceB2C.router');
// const rtoCharges=require("./RTO/rtoRouter")
// router.use("/Rto",isAuthorized,rtoCharges)
const allocationRouter = require("./addons/orderAllocationEngine/OAE.router");
const userRouter = require("./routes/user.router");
const WareHouse = require("./routes/warehouse.router");
const bulkOrderUploadRoutes = require("./routes/bulkOrderUpload.router");
const PrintLabelRoute = require("./label/printLabel.controller");
const PrintInvoice = require("./label/printInvoice.controller");
const PrintManifest = require("./label/printManifest.controller");
const AllCourierRoutes = require("./routes/allCourierRoutes");
const CourierServiceRoutes = require("./routes/courierServies.router");
const dashboard = require("./dashboard/dashboard,router");
const channel = require("./Channels/allChannel.routes");
const staffRoleRoutes = require("./routes/rolesRouter");
const trackSingleOrder = require("./Orders/tracking.controller");
const LabelSettings = require("./label/label.router");
const statusMap = require("./statusMap/StatusMap.router")
const EDDMap = require("./routes/EDDMap.router")
const EPDMap = require("./routes/EPDMap.router")
const ZipyPostRouter = require("./AllCouriersRoutes/zipypost.router")
const BoxdLogisticsRouter = require("./AllCouriersRoutes/boxdlogistics.router")
const ProshipRouter = require("./AllCouriersRoutes/proship.router")
const ShadowfaxRouter = require("./AllCouriersRoutes/shadowfax.router")
const CourierRouter = require("./routes/courier.router")
const referralRoute = require("./Referral/referal.router")
const Notification = require("./notification/notification.router")
const webhook = require("./webhook/webhook.router")
const Invoice = require("./Invoice/invoice.router")
const aiCallingRouter = require("./aiCalling/aiCalling.router")
const B2B = require("./B2B/routes");
router.use("/b2b", B2B);

router.use("/notification", Notification);
router.use("/ai-calling", aiCallingRouter);

router.use("/referral", referralRoute);
router.use("/courier", CourierRouter);
router.use("/statusMap", statusMap);
router.use("/EDD", EDDMap)
router.use("/EPD", EPDMap)
router.use("/webhook", webhook)
router.use("/invoice", Invoice);


router.use("/label", LabelSettings);

const adminOrderRoute = require("./routes/adminOrder.router");
const adminBilling = require("./Admin/adminRouter");

router.use("/admin", adminOrderRoute);
router.use("/adminBilling", adminBilling);

router.use("/channel", channel);
const ndrRoutes = require("./routes/ndr.router");
router.use("/ndr", ndrRoutes);
router.use("/dispreancy", isAuthorized, weightDispreancy);
//rate
const Cod = require("./COD/cod.router");
router.use("/cod", isAuthorized, Cod);
const RateCalculate = require("./routes/Ratecalculate.router");
router.use("/ratecalculate", isAuthorized, RateCalculate);

router.use("/allCourier", AllCourierRoutes);
const newOrderRoute = require("./routes/newOrder.router");
const bulk = require("./routes/newBulkOrders.routes");

router.use("/bulk", isAuthorized, bulk);
const Razorpay = require("./recharge/recharge.route");

const serviceablePincodeRoutes = require("./checkPincodeServiceability/checkPincodeServiceability.route");
router.use("/serviceablePincode", serviceablePincodeRoutes);

router.use("/external", authRouter);

router.use("/merchant", isAuthorized, verficationRouter);
router.use("/allocation", isAuthorized, allocationRouter);

router.use("/paytm", paytmRoutes);
router.use("/recharge", rechargeRouter);
router.use("/razorpay", Razorpay);
router.use("/courierServices", CourierServiceRoutes);

// router.use('/order', orderRouter);
router.use("/orders", newOrderRoute);
router.use("/order", isAuthorized, newOrderRoute);
router.use("/dashboard", isAuthorized, dashboard);
// router.use("/order", orderRouter);
//create product route
// router.use("/products",productRouter)

router.use("/users", userController);
router.use("/calculateRate", calculateRouter);
// router.use("/getServices", servicesController);

router.use("/saveRate", saveRateRouter);
const costingRateRouter = require("./routes/costingRate.router");
router.use("/costingRate", costingRateRouter);
router.use("/getBaseRate", getBaseRateController);
router.use("/saveBaseRate", saveBaseRateController);
router.use("/saveCustomRate", customRateController);
// router.use('/editBaseRate', editBaseRateController);

router.use("/NimbusPost", NimbusPostController);
router.use("/Shiprocket", ShipRocketController);
router.use("/EcomExpress", EcomExpressController);
router.use("/Xpressbees", XpressbeesController);
router.use("/ShreeMaruti", shreeMarutiController);
router.use("/Smartship", SmartShipController);
router.use("/Dtdc", DtdcController);
router.use("/Delhivery", DelhiveryController);
router.use("/AmazonShipping", AmazonRouter);
router.use("/Ekart", Ekart)
router.use("/Vamaship", Vamaship)
router.use("/ZipyPost", ZipyPostRouter)
router.use("/BoxdLogistics", BoxdLogisticsRouter)
router.use("/Proship", ProshipRouter)
router.use("/Shadowfax", ShadowfaxRouter)

router.use("/label", LabelRouter);
router.use("/user", userRouter);
router.use("/warehouse", WareHouse);
router.use("/bulkOrderUpload", isAuthorized, bulkOrderUploadRoutes);
router.use("/printlabel", PrintLabelRoute);
router.use("/printinvoice", PrintInvoice);
router.use("/manifest", PrintManifest);

// router.use("/B2Ccouries", couriersB2CRoutes);

router.use("/getKyc", isAuthorized, getKyc);
// app.use("/v1/courierServices", courierServicesRoutes);

//this is staffRole route
router.use("/staffRole", staffRoleRoutes);

//ticket
const ticketRoutes = require("./routes/TicketRoutes");
router.use("/support", ticketRoutes);

//API routes
const api = require("./API/Router/api.router");
const { saveZipypost } = require("./AllCouriers/Zipypost/Authorize/zipyPost.controller");
const announcementRouter = require("./announcement/announcement.route");
router.use("/announcement", announcementRouter);

const agreementRoutes = require("./agreement/agreement.routes");
router.use("/agreement", agreementRoutes);

router.use("/api", api);

module.exports = router;
