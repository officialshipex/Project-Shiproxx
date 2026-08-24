/**
 * One-off repair script for AllChannel documents that got saved without a
 * webhookId (a bug in storeAllChannelDetails silently swallowed webhook
 * registration failures — fixed in Channels/allChannel.controller.js, but
 * this repairs channels that were already saved broken before that fix).
 *
 * For each broken channel, retries the exact same webhook-registration call
 * the live server uses (createWebhook / createWooCommerceWebhook), and
 * either fixes the record in place or prints the real underlying error so
 * you know exactly what credential/config to correct.
 *
 * Safe to re-run: only touches documents with a missing/empty webhookId.
 *
 * Run from the backend root:
 *   node scripts/repairChannelWebhooks.js
 */

require("dotenv").config();
const dns = require("dns");
if (process.env.NODE_ENV !== "production") {
  dns.setServers(["1.1.1.1", "8.8.8.8"]);
}
const mongoose = require("mongoose");

const AllChannel = require("../Channels/allChannel.model");
const { createWebhook } = require("../Channels/allChannel.controller");
const { createWooCommerceWebhook } = require("../Channels/WooCommerce/woocommerce.controller");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log("Connected to DB.\n");

  const broken = await AllChannel.find({
    $or: [{ webhookId: { $exists: false } }, { webhookId: null }, { webhookId: "" }],
  });

  if (broken.length === 0) {
    console.log("No channels with a missing webhookId found. Nothing to repair.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${broken.length} channel(s) with a missing webhookId:\n`);

  let fixed = 0;
  let stillBroken = 0;

  for (const doc of broken) {
    console.log("----------------------------------------");
    console.log(`Channel _id: ${doc._id}`);
    console.log(`  channel:   ${doc.channel}`);
    console.log(`  storeURL:  ${doc.storeURL}`);
    console.log(`  storeName: ${doc.storeName}`);

    if (doc.channel === "Shopify") {
      const result = await createWebhook(doc.storeURL, doc.storeAccessToken);
      if (result?.error) {
        console.log(`  ❌ Shopify webhook registration failed:`);
        console.log(`     ${JSON.stringify(result.error)}`);
        console.log(`  → Fix the credentials for this store (Store URL / Client ID / Client Secret / Access Token) and re-run this script.`);
        stillBroken++;
        continue;
      }
      const webhookId = result?.webhook?.id;
      if (!webhookId) {
        console.log(`  ❌ Shopify call succeeded but returned no webhook id:`, result);
        stillBroken++;
        continue;
      }
      doc.webhookId = webhookId;
      await doc.save();
      console.log(`  ✅ Fixed — webhookId set to ${webhookId}`);
      fixed++;
    } else if (doc.channel === "WooCommerce") {
      let result;
      try {
        result = await createWooCommerceWebhook(doc.storeURL, doc.storeClientId, doc.storeClientSecret);
      } catch (err) {
        console.log(`  ❌ WooCommerce webhook registration failed:`);
        console.log(`     ${err.message}`);
        console.log(`  → Fix the credentials for this store (Store URL / Consumer Key / Consumer Secret) and re-run this script.`);
        stillBroken++;
        continue;
      }
      const webhookId = result?.id || result?.webhook?.id;
      if (!webhookId) {
        console.log(`  ❌ WooCommerce call succeeded but returned no webhook id:`, result);
        stillBroken++;
        continue;
      }
      doc.webhookId = webhookId;
      if (result?.secret) doc.webhookSecret = result.secret;
      await doc.save();
      console.log(`  ✅ Fixed — webhookId set to ${webhookId}${result?.secret ? " (webhook secret captured)" : ""}`);
      fixed++;
    } else {
      console.log(`  ⚠️ Unrecognized channel type "${doc.channel}" — skipping.`);
      stillBroken++;
    }
  }

  console.log("----------------------------------------\n");
  console.log(`Done. Fixed: ${fixed}. Still broken: ${stillBroken}.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Repair script failed:", err);
  process.exit(1);
});
