/**
 * Live end-to-end test: sends a realistic, properly HMAC-signed fake Shopify
 * "orders/create" webhook payload to the real production endpoint, then
 * verifies the resulting Order document was stored correctly in the DB.
 * Deliberately uses a billing_address that's obviously different from the
 * real seller's saved pickup address, specifically to confirm the pickup
 * address bug fix (the order should use the seller's real PickupAddress,
 * not the fake billing_address below).
 *
 * If no primary pickup address exists yet, creates a temporary, clearly
 * labeled one so the test can run — always removed at the end (only if this
 * script created it; a real pre-existing one is never touched).
 * Always cleans up the test order at the end too, pass or fail.
 *
 * Usage (from backend root):
 *   node scripts/testShopifyOrderSync.js
 */

require("dotenv").config();
const dns = require("dns");
if (process.env.NODE_ENV !== "production") {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}
const mongoose = require("mongoose");
const axios = require("axios");
const crypto = require("crypto");

const AllChannel = require("../Channels/allChannel.model");
const Order = require("../models/newOrder.model");
const PickupAddress = require("../models/pickupAddress.model");

const WEBHOOK_URL = "https://api.shiproxx.com/v1/channel/webhook/orders";
const STORE_DOMAIN = "uhbfb0-j9.myshopify.com";

// Distinctive fake Shopify order id so it's unmistakable and easy to clean up.
const FAKE_SHOPIFY_ORDER_ID = 990000000001;

async function run() {
  const channel = await AllChannel.findOne({ storeURL: STORE_DOMAIN, channel: "Shopify" });
  if (!channel) {
    console.error(`Channel for ${STORE_DOMAIN} not found.`);
    return;
  }

  let primaryPickup = await PickupAddress.findOne({ userId: channel.userId, isPrimary: true }).lean();
  let createdTestPickupAddress = false;

  try {
    if (!primaryPickup) {
      console.log("No primary pickup address on file — creating a temporary test one (will be removed at the end).\n");
      const created = await PickupAddress.create({
        userId: channel.userId,
        isPrimary: true,
        pickupAddress: {
          contactName: "CLAUDE TEST PICKUP - SAFE TO DELETE",
          email: "claude-test-pickup@example.com",
          phoneNumber: "8888888888",
          address: "1 Test Warehouse Road",
          pinCode: "560001",
          city: "Bengaluru",
          state: "Karnataka",
        },
      });
      primaryPickup = created.toObject();
      createdTestPickupAddress = true;
    }

    console.log("Seller pickup address that will be used for this test:");
    console.log(`  ${primaryPickup.pickupAddress.contactName}, ${primaryPickup.pickupAddress.city}, ${primaryPickup.pickupAddress.pinCode}\n`);

    const compositeOrderId = `${STORE_DOMAIN}-${FAKE_SHOPIFY_ORDER_ID}`;

    // Clean up any leftover order from a previous test run first.
    await Order.deleteOne({ compositeOrderId });

    const fakeShopifyOrder = {
      id: FAKE_SHOPIFY_ORDER_ID,
      email: "claude-test@example.com",
      financial_status: "pending", // exercises the COD path
      total_price: "999.00",
      billing_address: {
        // Deliberately WRONG on purpose — should NOT end up as the order's
        // pickupAddress if the bug fix is working (that should come from the
        // seller's real saved PickupAddress instead).
        name: "FAKE BILLING - SHOULD NOT APPEAR AS PICKUP",
        address1: "1 Fake Billing Street",
        city: "FakeBillingCity",
        zip: "000001",
        phone: "1111111111",
      },
      shipping_address: {
        name: "CLAUDE TEST ORDER - SAFE TO DELETE",
        address1: "221B Test Receiver Lane",
        city: "Mumbai",
        province: "Maharashtra",
        zip: "400001",
        phone: "9999999999",
      },
      line_items: [
        {
          id: 5550001,
          product_id: 1234567890, // fake — product lookup will fail gracefully
          quantity: 1,
          name: "Claude Test Product",
          sku: "TEST-SKU-001",
          price: "999.00",
        },
      ],
    };

    const rawBody = Buffer.from(JSON.stringify(fakeShopifyOrder), "utf8");
    const signature = crypto
      .createHmac("sha256", channel.storeClientSecret)
      .update(rawBody)
      .digest("base64");

    console.log(`POSTing simulated Shopify order ${FAKE_SHOPIFY_ORDER_ID} to ${WEBHOOK_URL} ...\n`);

    let webhookResponse;
    try {
      webhookResponse = await axios.post(WEBHOOK_URL, rawBody, {
        headers: {
          "Content-Type": "application/json",
          "x-shopify-shop-domain": STORE_DOMAIN,
          "x-shopify-hmac-sha256": signature,
        },
        timeout: 20000,
        validateStatus: () => true, // we want to see errors, not throw
      });
    } catch (err) {
      console.error("Request failed:", err.message);
      return;
    }

    console.log(`Webhook response: HTTP ${webhookResponse.status}`);
    console.log(JSON.stringify(webhookResponse.data, null, 2));
    console.log("");

    // Give the DB a moment in case the handler does any async follow-up.
    await new Promise((r) => setTimeout(r, 1500));

    const savedOrder = await Order.findOne({ compositeOrderId }).lean();

    if (!savedOrder) {
      console.log("❌ No Order document was created. See the webhook response above for the reason.");
      return;
    }

    console.log("✅ Order document created. Verifying fields:\n");

    const check = (label, actual, expected) => {
      const pass = String(actual) === String(expected);
      console.log(`${pass ? "✅" : "❌"} ${label}: ${JSON.stringify(actual)} ${pass ? "" : `(expected ${JSON.stringify(expected)})`}`);
      return pass;
    };

    let allPass = true;
    allPass &= check("channel", savedOrder.channel, "Shopify");
    allPass &= check("storeUrl", savedOrder.storeUrl, STORE_DOMAIN);
    allPass &= check("compositeOrderId", savedOrder.compositeOrderId, compositeOrderId);
    allPass &= check("status", savedOrder.status, "new");
    allPass &= check("pickupAddress.contactName (should be the REAL seller address, not the fake billing one)",
      savedOrder.pickupAddress?.contactName, primaryPickup.pickupAddress.contactName);
    allPass &= check("pickupAddress.city", savedOrder.pickupAddress?.city, primaryPickup.pickupAddress.city);
    allPass &= check("pickupAddress.pinCode", savedOrder.pickupAddress?.pinCode, primaryPickup.pickupAddress.pinCode);
    allPass &= check("receiverAddress.contactName", savedOrder.receiverAddress?.contactName, "CLAUDE TEST ORDER - SAFE TO DELETE");
    allPass &= check("receiverAddress.city", savedOrder.receiverAddress?.city, "Mumbai");
    allPass &= check("receiverAddress.pinCode", savedOrder.receiverAddress?.pinCode, "400001");
    allPass &= check("paymentDetails.method", savedOrder.paymentDetails?.method, "COD");
    allPass &= check("paymentDetails.amount", savedOrder.paymentDetails?.amount, 999);
    allPass &= check("productDetails[0].name", savedOrder.productDetails?.[0]?.name, "Claude Test Product");
    allPass &= check("productDetails[0].sku", savedOrder.productDetails?.[0]?.sku, "TEST-SKU-001");
    allPass &= check("tracking[0].Instructions", savedOrder.tracking?.[0]?.Instructions, "Order synced from Shopify");

    console.log(`\n${allPass ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED — see above"}`);
    console.log("\nFull stored document:");
    console.log(JSON.stringify(savedOrder, null, 2));

    await Order.deleteOne({ compositeOrderId });
    console.log("\n🧹 Test order deleted from the database.");
  } finally {
    if (createdTestPickupAddress) {
      await PickupAddress.deleteOne({ _id: primaryPickup._id });
      console.log("🧹 Temporary test pickup address removed.");
    }
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log("Connected to DB.\n");
  try {
    await run();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Test script failed:", err);
  process.exit(1);
});
