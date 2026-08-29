
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");
require("dotenv").config();

// Read-only diagnostic: for a given orderId, checks each of the three gates
// ShipeNowOrder (Orders/newOrder.controller.js) applies BEFORE it ever calls
// checkServiceabilityBoxdLogistics, to find out which one is filtering
// BoxdLogistics out entirely (matches the console.log in that function never
// firing — the function is never being reached, not returning empty).
//
// Usage: node diagnoseBoxdServiceability.js <orderId>
// Example: node diagnoseBoxdServiceability.js 128046

const normalize = (str) => str?.toString().toLowerCase().replace(/\s+/g, "").trim();

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error("Usage: node diagnoseBoxdServiceability.js <orderId>");
    process.exit(1);
  }

  console.log("Connecting to database...");
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 60000,
  });
  console.log("Database connected\n");

  const db = mongoose.connection.db;

  const order = await db.collection("neworders").findOne({ orderId: Number(orderId) });
  if (!order) {
    console.log(`No order found with orderId=${orderId}`);
    await mongoose.disconnect();
    return;
  }
  console.log(`Order ${orderId}: _id=${order._id}  userId=${order.userId}  status=${order.status}`);
  console.log(`  pickup pincode: ${order.pickupAddress?.pinCode}`);
  console.log(`  applicableWeight: ${order.packageDetails?.applicableWeight}`);

  // ── Gate 1: CourierService records for BoxdLogistics ──
  console.log("\n[Gate 1] CourierService records where provider ~ BoxdLogistics:");
  const services = await db.collection("courierservices").find({}).toArray();
  const boxdServices = services.filter((s) => normalize(s.provider) === "boxdlogistics");
  if (boxdServices.length === 0) {
    console.log("  None found at all (any status). This alone would explain zero results.");
  } else {
    boxdServices.forEach((s) => {
      console.log(`  - name="${s.name}"  status=${s.status}  courier_id=${JSON.stringify(s.courier_id)}`);
    });
  }

  // ── Gate 2: AllCourier (provider-level) record for BoxdLogistics ──
  console.log("\n[Gate 2] AllCourier (provider-level) record where courierProvider ~ BoxdLogistics:");
  const allCouriers = await db.collection("allcouriers").find({}).toArray();
  let providerRecords = allCouriers.filter((c) => normalize(c.courierProvider) === "boxdlogistics");
  if (providerRecords.length === 0) {
    // collection name guess fallback — Mongoose pluralizes "allCourier" model name differently
    const altCouriers = await db.collection("allcourier").find({}).toArray().catch(() => []);
    providerRecords = altCouriers.filter((c) => normalize(c.courierProvider) === "boxdlogistics");
  }
  if (providerRecords.length === 0) {
    console.log("  None found. enabledServices filter requires this to exist AND be status=Enable —");
    console.log("  if missing, EVERY BoxdLogistics CourierService is filtered out regardless of its own status.");
  } else {
    providerRecords.forEach((c) => {
      console.log(`  - courierName="${c.courierName}"  courierProvider="${c.courierProvider}"  status=${c.status}`);
    });
  }

  // ── Gate 3: Plan rateCard entry for BoxdLogistics ──
  console.log("\n[Gate 3] Plan.rateCard entries where courierProviderName ~ BoxdLogistics (for this order's user):");
  const plan = await db.collection("plans").findOne({ userId: order.userId });
  if (!plan) {
    console.log(`  No Plan document found for userId=${order.userId}`);
  } else {
    const boxdRateCards = (plan.rateCard || []).filter(
      (card) => normalize(card.courierProviderName) === "boxdlogistics"
    );
    if (boxdRateCards.length === 0) {
      console.log("  None found in this user's plan.rateCard. This alone would explain zero results —");
      console.log("  ShipeNowOrder requires an Active rate card row matching the provider (courierServiceName");
      console.log("  match is skipped for BoxdLogistics specifically, but the row must still exist and be Active).");
    } else {
      boxdRateCards.forEach((card) => {
        console.log(`  - courierServiceName="${card.courierServiceName}"  status=${card.status}`);
      });
    }
  }

  console.log("\nDone. The gate(s) printing \"None found\" above is what's filtering BoxdLogistics out");
  console.log("before checkServiceabilityBoxdLogistics is ever called.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
