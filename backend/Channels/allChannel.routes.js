const express = require("express");
const router = express.Router();
const {isAuthorized}=require("../middleware/auth.middleware")
const app=express();
app.use(express.json());

const{storeAllChannelDetails,webhookhandler,getAllChannel,getOneChannel,updateChannel,deleteChannel,fulfillOrder,fetchExistingOrders}=require("./allChannel.controller")
const {wooCommerceWebhookHandler}=require("./WooCommerce/woocommerce.controller")
router.post("/storeAllChannelDetails",isAuthorized,storeAllChannelDetails)
// Webhook signature verification uses req.rawBody, captured globally by the
// verify() callback on the app-wide express.json() in server.js.
router.post("/webhook/orders", webhookhandler);
router.post("/webhook/woocommerce", wooCommerceWebhookHandler)
router.get("/getAllChannel",isAuthorized,getAllChannel)
router.get("/getOneChannel/:id",isAuthorized,getOneChannel)
router.put("/updateChannel/:id",isAuthorized,updateChannel)
router.delete("/delete/:id",isAuthorized,deleteChannel)
router.post("/fulfillOrder",isAuthorized,fulfillOrder)
router.post("/fetchOrder",isAuthorized,fetchExistingOrders)

module.exports=router