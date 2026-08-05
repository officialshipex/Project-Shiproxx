const webhookRouter = require('express').Router();
// const {DelhiveryWebhook}=require("./webhook.controller")
const { ShreeMarutiWebhook } = require("./ShreeMarutiWebhook.controller")
const { AmazonShippingWebhook } = require("./AmasonShippingWebhook.controller")
const { DTDCWebhook } = require("./DtdcWebhook.controller")
const { DelhiveryWebhook } = require("./DelhiveryWebhook.controller")
const { EkartWebhook } = require("./EkartWebhook.controller")
const { AmazonShippingNDRWebhook } = require("./NDR/AmazonShippingWebhook.controller")
const { ProshipWebhook } = require("./ProshipWebhook.controller")
const { ShipRocketWebhook } = require("./ShipRocketWebhook.controller")
const { ShadowfaxWebhook } = require("./ShadowfaxWebhook.controller")
const { ShipexIndiaWebhook } = require("./ShipexIndiaWebhook.controller")


const { delhiveryManifestCallback } = require("../B2B/controller/Couriers/AllCouriers/Delhivery/Courier/couriers.controller")

const outgoingWebhookRouter = require("./outgoingWebhook.router");

webhookRouter.post('/delhivery', DelhiveryWebhook);
webhookRouter.post('/ekart', EkartWebhook);
webhookRouter.post("/shree-maruti", ShreeMarutiWebhook);
webhookRouter.post("/dtdc", DTDCWebhook);
webhookRouter.post("/amazon-shipping", AmazonShippingWebhook);
webhookRouter.post("/tracking-info-updates", ShipRocketWebhook);

webhookRouter.post("/amazon-shipping-ndr", AmazonShippingNDRWebhook);
webhookRouter.post("/proship", ProshipWebhook);
webhookRouter.post("/shadowfax", ShadowfaxWebhook);
webhookRouter.post("/shipexindia", ShipexIndiaWebhook);


webhookRouter.post("/delhivery/manifest", delhiveryManifestCallback)

// ── Outgoing webhook management routes (CRUD + logs) ──
webhookRouter.use("/manage", outgoingWebhookRouter);

// ── Test receiver endpoint — used to verify outgoing webhook connectivity ──
// Users configure https://api.shiproxx.com/v1/webhook/shiproxx as their test URL.
webhookRouter.post("/shiproxx", (req, res) => {
  const eventTopic = req.headers["x-shiproxx-event"] || "unknown";
  const webhookId = req.headers["x-shiproxx-webhook-id"] || "unknown";
  const isTest = req.headers["x-shiproxx-test"] === "true";
  const signature = req.headers["x-shiproxx-signature"] || "not-provided";

  console.log(`[Shiproxx Receiver] 📩 Incoming webhook`);
  console.log(`  Event     : ${eventTopic}`);
  console.log(`  WebhookID : ${webhookId}`);
  console.log(`  Test      : ${isTest}`);
  console.log(`  Signature : ${signature}`);
  console.log(`  Payload   :`, JSON.stringify(req.body, null, 2));

  return res.status(200).json({
    received: true,
    event: eventTopic,
    webhookId,
    test: isTest,
    message: "Webhook received successfully by Shiproxx",
  });
});

module.exports = webhookRouter;



