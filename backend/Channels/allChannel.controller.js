const { message } = require("../addons/utils/shippingRulesValidation");
const AllChannel = require("./allChannel.model"); // Adjust path if necessary
const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const app = express();
app.use(express.json());
const Order = require("../models/newOrder.model");
const PickupAddress = require("../models/pickupAddress.model");
const { generateUniqueOrderIds } = require("../utils/generateUniqueOrderId");
const {
  createWooCommerceWebhook,
} = require("./WooCommerce/woocommerce.controller");

// Verify a Shopify webhook's HMAC SHA256 signature against the store's own
// API secret key (the same "storeClientSecret" collected at connect time —
// Shopify signs webhooks with a Custom App's secret key by default).
const verifyShopifyHmac = (req, storeClientSecret) => {
  const signature = req.headers["x-shopify-hmac-sha256"];
  if (!storeClientSecret || !signature || !req.rawBody) return false;
  const expected = crypto
    .createHmac("sha256", storeClientSecret)
    .update(req.rawBody)
    .digest("base64");
  try {
    const expectedBuf = Buffer.from(expected, "base64");
    const signatureBuf = Buffer.from(signature, "base64");
    if (expectedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch (err) {
    return false;
  }
};

// The "Store URL" field is free text, and sellers frequently paste what
// their browser shows them — Shopify's newer admin UI lives at
// admin.shopify.com/store/<handle>, not <handle>.myshopify.com — or just
// the bare handle with no domain at all. admin.shopify.com is the
// interactive merchant UI and sits behind a Cloudflare bot/JS challenge for
// anything that isn't a real browser session, so pointing server-to-server
// calls (OAuth token exchange, webhook registration) at it returns an HTML
// "Verifying your connection..." page instead of JSON — that's the "Failed
// to generate Shopify access token" error with HTML in it. Always resolve
// to the canonical <handle>.myshopify.com API host before using a Shopify
// storeURL for anything.
const normalizeShopifyStoreURL = (rawURL) => {
  let cleaned = String(rawURL || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");

  // e.g. "admin.shopify.com/store/kwvcb0-hh" or
  // "admin.shopify.com/store/kwvcb0-hh/settings/whatever"
  const adminMatch = cleaned.match(/^admin\.shopify\.com\/store\/([^/]+)/i);
  if (adminMatch) {
    return `${adminMatch[1]}.myshopify.com`.toLowerCase();
  }

  // Drop any trailing path, keep just the host
  cleaned = cleaned.split("/")[0];

  // Bare shop handle with no dots, e.g. "kwvcb0-hh"
  if (cleaned && !cleaned.includes(".")) {
    return `${cleaned}.myshopify.com`.toLowerCase();
  }

  return cleaned.toLowerCase();
};

// Shopify's Client Credentials grant (POST /admin/oauth/access_token with
// the store's Client ID + Client Secret) is how a Custom App gets its
// access token — and that token is short-lived (observed expires_in
// ~86399s, i.e. under 24h), not a one-time/permanent credential. There's no
// separate "refresh token" step; getting a new one is the exact same call.
const generateShopifyAccessToken = async (storeURL, storeClientId, storeClientSecret) => {
  const response = await axios.post(
    `https://${storeURL}/admin/oauth/access_token`,
    {
      grant_type: "client_credentials",
      client_id: storeClientId,
      client_secret: storeClientSecret,
    },
    { headers: { "Content-Type": "application/json" } }
  );
  const { access_token, expires_in } = response.data || {};
  if (!access_token) throw new Error("Shopify did not return an access_token");
  return {
    accessToken: access_token,
    // Shave a safety buffer off Shopify's own expiry — see
    // SHOPIFY_TOKEN_REFRESH_BUFFER_MS below for why.
    expiresAt: new Date(Date.now() + (expires_in || 86399) * 1000),
  };
};

const SHOPIFY_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

// Returns a valid Shopify access token for this specific store, refreshing
// it first if it's missing or within SHOPIFY_TOKEN_REFRESH_BUFFER_MS of
// expiring. Every Shopify API call site should call this immediately
// before making its request rather than reading store.storeAccessToken
// directly — that's what keeps this self-healing instead of requiring a
// seller to notice and re-paste a token roughly once a day. Operates only
// on the single `store` document passed in (keyed by its own _id), so
// having multiple Shopify channels connected refreshes each independently
// with no cross-contamination.
const getValidShopifyAccessToken = async (store) => {
  const hasValidToken =
    store.storeAccessToken &&
    store.storeAccessTokenExpiresAt &&
    new Date(store.storeAccessTokenExpiresAt).getTime() - Date.now() > SHOPIFY_TOKEN_REFRESH_BUFFER_MS;

  if (hasValidToken) return store.storeAccessToken;

  if (!store.storeClientId || !store.storeClientSecret) {
    throw new Error(`Store ${store.storeURL} has no Client ID/Secret on file — cannot refresh its Shopify access token.`);
  }

  console.log(`🔄 Refreshing Shopify access token for store ${store.storeURL}...`);
  const { accessToken, expiresAt } = await generateShopifyAccessToken(
    store.storeURL,
    store.storeClientId,
    store.storeClientSecret
  );

  await AllChannel.findByIdAndUpdate(store._id, {
    $set: { storeAccessToken: accessToken, storeAccessTokenExpiresAt: expiresAt },
  });
  console.log(`✅ Shopify access token refreshed for store ${store.storeURL}, expires at ${expiresAt.toISOString()}`);

  // Keep the in-memory doc consistent in case the caller keeps using
  // `store` afterward instead of re-fetching it.
  store.storeAccessToken = accessToken;
  store.storeAccessTokenExpiresAt = expiresAt;

  return accessToken;
};

const createWebhook = async (storeURL, storeAccessToken) => {
  const webhookURL = "https://api.shiproxx.com/v1/channel/webhook/orders";
  const webhookTopic = "orders/create";

  try {
    // Step 1: Fetch existing webhooks
    const existingWebhooksResponse = await axios.get(
      `https://${storeURL}/admin/api/2025-01/webhooks.json`,
      {
        headers: {
          "X-Shopify-Access-Token": storeAccessToken,
          "Content-Type": "application/json",
        },
      }
    );

    const existingWebhooks = existingWebhooksResponse.data.webhooks;

    // Step 2: Check if the webhook already exists
    const existingWebhook = existingWebhooks.find(
      (wh) => wh.address === webhookURL && wh.topic === webhookTopic
    );

    if (existingWebhook) {
      console.log("Webhook already exists:", existingWebhook.id);
      return { message: "Webhook already exists", webhook: existingWebhook };
    }

    // Step 3: Create the webhook if it does not exist
    const response = await axios.post(
      `https://${storeURL}/admin/api/2025-01/webhooks.json`,
      {
        webhook: {
          topic: webhookTopic,
          address: webhookURL,
          format: "json",
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": storeAccessToken,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Webhook Created:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error creating webhook:", error.response?.data || error.message);
    return { error: error.response?.data || error.message };
  }
};

// Shopify's `order.total_weight` is the sum of every line item's weight
// (already multiplied by quantity) in grams, regardless of the shop's
// configured weight unit — unlike `variants[0].weight`, which is in
// whatever unit that variant's `weight_unit` says (g/kg/oz/lb) and was
// previously being stored as-is into a field couriers treat as kilograms,
// turning a 500g item into a "500kg" shipment. Converting from grams here
// sidesteps unit ambiguity entirely and needs no extra Shopify API calls.
const getOrderWeightKg = (shopifyOrder) => {
  const totalGrams = Number(shopifyOrder.total_weight);
  if (!totalGrams || totalGrams <= 0) return 0.5; // Shopify gave us nothing usable — sane default, not 0
  return totalGrams / 1000;
};

// Used whenever a synced order is missing data we'd otherwise require (no
// primary pickup address configured yet, etc.) — the order still gets
// created with an obvious placeholder rather than silently never syncing,
// so the seller can see it landed and knows exactly what to fix.
const DUMMY_PICKUP_ADDRESS = {
  contactName: "Pickup Address Not Set",
  email: "pickup-not-set@shiproxx.com",
  phoneNumber: "0000000000",
  address: "Pickup address not configured — please update in Set Up & Manage",
  pinCode: "000000",
  city: "Not Set",
  state: "Not Set",
};

const fetchExistingOrders = async (req, res) => {
  try {
    const userId = req.user._id;

    const channel = await AllChannel.findOne({
      userId,
      channel: "Shopify",
    });

    if (!channel) {
      return res
        .status(404)
        .json({ success: false, message: "Shopify channel not connected." });
    }

    // Fetch the seller's own warehouse/pickup address — NOT the customer's
    // billing address, which was being used below before. If none is
    // configured, fall back to a placeholder rather than blocking the whole
    // sync — orders still get created and the seller can fix it afterward.
    const primaryPickup = await PickupAddress.findOne({
      userId,
      isPrimary: true,
    }).lean();

    if (!primaryPickup || !primaryPickup.pickupAddress) {
      console.warn(`⚠️ No primary pickup address configured for user ${userId} — using placeholder pickup address.`);
    }
    const pickupAddressData = primaryPickup?.pickupAddress || DUMMY_PICKUP_ADDRESS;

    const accessToken = await getValidShopifyAccessToken(channel);
    const storeURL = channel.storeURL;

    let allOrders = [];
    let pageInfo = null;

    do {
      const response = await axios.get(
        `https://${storeURL}/admin/api/2024-01/orders.json`,
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          params: {
            status: "any",
            limit: 250,
            ...(pageInfo && { page_info: pageInfo }),
          },
        }
      );

      allOrders.push(...response.data.orders);

      const linkHeader = response.headers["link"];
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^&>]+)/);
        pageInfo = match ? match[1] : null;
      } else {
        pageInfo = null;
      }
    } while (pageInfo);

    for (const order of allOrders) {
      const compositeOrderId = `${storeURL}-${order.id}`;

      const existingOrder = await Order.findOne({ compositeOrderId });
      if (existingOrder) {
        console.log(`Order ${order.id} already exists. Skipping...`);
        continue;
      }

      // Extract product details
      const orderLineItems = order.line_items || [];
      const productDetails = orderLineItems.map((item) => ({
        id: item.id,
        quantity: item.quantity,
        name: item.name,
        sku: item.sku,
        unitPrice: item.price,
      }));

      // Default package dimensions — Shopify doesn't expose package
      // dimensions on products/orders, so these stay fixed placeholders.
      const totalWeight = getOrderWeightKg(order);
      const totalLength = 10,
        totalWidth = 10,
        totalHeight = 10;

      // Generate a unique internal orderId (do not use Shopify's order_number to avoid duplicates)
      const internalOrderId = await generateUniqueOrderIds(1);

      const newOrder = new Order({
        userId: channel.userId,
        orderId: internalOrderId,
        channelId: order.id,
        channelOrderName: order.name || (order.order_number ? `#${order.order_number}` : undefined),
        compositeOrderId,
        channel: "Shopify",
        storeUrl: storeURL,
        pickupAddress: {
          contactName: pickupAddressData.contactName,
          email: pickupAddressData.email,
          phoneNumber: pickupAddressData.phoneNumber,
          address: pickupAddressData.address,
          pinCode: pickupAddressData.pinCode,
          city: pickupAddressData.city,
          state: pickupAddressData.state,
        },
        receiverAddress: {
          contactName: order.shipping_address?.name || "N/A",
          email: order.email || "unknown@example.com",
          phoneNumber: order.shipping_address?.phone || "0000000000",
          address: order.shipping_address?.address1 || "Not Provided",
          pinCode: order.shipping_address?.zip || "000000",
          city: order.shipping_address?.city || "Unknown",
          state: order.shipping_address?.province || "Unknown",
        },
        productDetails,
        packageDetails: {
          deadWeight: totalWeight,
          applicableWeight: totalWeight,
          volumetricWeight: {
            length: totalLength,
            width: totalWidth,
            height: totalHeight,
          },
        },
        paymentDetails: {
          method: order.financial_status === "paid" ? "Prepaid" : "COD",
          amount:
            order.financial_status === "paid"
              ? 0
              : parseFloat(order.total_price || 0),
        },
        status: "new",
        tracking: [
          {
            status: "new",
            StatusLocation: order.shipping_address?.city || "N/A",
            StatusDateTime: new Date(),
            Instructions: "Order fetched from Shopify",
          },
        ],
      });

      await newOrder.save();
      console.log(`Saved new order ${order.order_number} (${order.id})`);
    }

    channel.lastSync = new Date();
    await channel.save();

    res.status(200).json({
      success: true,
      message: "All orders synced successfully.",
    });
  } catch (error) {
    console.error(
      "Error fetching existing orders:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      message: "Error in syncing orders.",
    });
  }
};

// Call it directly

const webhookhandler = async (req, res) => {
  try {
    const storeURL = req.headers["x-shopify-shop-domain"];
    console.log("storeURL", storeURL);

    if (!storeURL) {
      console.error("Missing x-shopify-shop-domain header on webhook request");
      return res.status(400).json({ error: "Missing shop domain header" });
    }

    // Shopify always sends the bare canonical domain here, but storeURL is
    // saved verbatim from whatever the seller typed when connecting the
    // store (no trim/case normalization anywhere in that path) — a stray
    // trailing slash or case difference breaks an exact match forever even
    // though the store connected fine. Match tolerantly, same as the other
    // Shopify/WooCommerce store lookups in this codebase (see
    // markShopifyOrderAsShipped below and woocommerce.controller.js).
    const escapedStoreURL = storeURL
      .replace(/\/$/, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const user = await AllChannel.findOne({
      storeURL: { $regex: `^${escapedStoreURL}/?$`, $options: "i" },
    });
    if (!user) {
      console.error("Store not found in AllChannel");
      return res.status(404).json({ error: "Store not found" });
    }

    if (!verifyShopifyHmac(req, user.storeClientSecret)) {
      console.warn(`❌ Shopify webhook signature mismatch for store ${storeURL}`);
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    // Fetch the seller's own warehouse/pickup address — NOT the customer's
    // billing address, which was being used here before. If none is
    // configured yet, fall back to an obvious placeholder rather than
    // dropping the order — a synced order with a placeholder the seller can
    // fix is far better than an order that silently never showed up at all.
    const primaryPickup = await PickupAddress.findOne({
      userId: user.userId,
      isPrimary: true,
    }).lean();

    if (!primaryPickup || !primaryPickup.pickupAddress) {
      console.warn(`⚠️ No primary pickup address configured for user ${user.userId} — using placeholder pickup address for store ${storeURL}.`);
    }
    const pickupAddressData = primaryPickup?.pickupAddress || DUMMY_PICKUP_ADDRESS;

    const shopifyOrder = req.body;
    const compositeOrderId = `${storeURL}-${shopifyOrder.id}`;
    const lineItems = shopifyOrder.line_items || [];

    // Check for existing order using compositeOrderId
    const existingOrder = await Order.findOne({ compositeOrderId });
    if (existingOrder) {
      console.log(`Order ${compositeOrderId} already exists, skipping...`);
      return res.status(200).json({ message: "Duplicate order ignored" });
    }

    // Extract product details
    const productDetails = lineItems.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      name: item.name,
      sku: item.sku,
      unitPrice: item.price,
    }));

    // Package weight & dimensions — Shopify doesn't expose package
    // dimensions on products/orders, so these stay fixed placeholders.
    const totalWeight = getOrderWeightKg(shopifyOrder);
    const totalLength = 10,
      totalWidth = 10,
      totalHeight = 10;

    // Generate a unique internal orderId (do not use Shopify's order_number to avoid duplicates)
    const internalOrderId = await generateUniqueOrderIds(1);

    const newOrder = new Order({
      userId: user.userId,
      orderId: internalOrderId,
      compositeOrderId, // Ensure uniqueness
      channelId: shopifyOrder.id,
      channelOrderName: shopifyOrder.name || (shopifyOrder.order_number ? `#${shopifyOrder.order_number}` : undefined),
      channel: "Shopify",
      storeUrl: storeURL,
      pickupAddress: {
        contactName: pickupAddressData.contactName,
        email: pickupAddressData.email,
        phoneNumber: pickupAddressData.phoneNumber,
        address: pickupAddressData.address,
        pinCode: pickupAddressData.pinCode,
        city: pickupAddressData.city,
        state: pickupAddressData.state,
      },
      receiverAddress: {
        contactName: shopifyOrder.shipping_address?.name || "N/A",
        email: shopifyOrder.email || "abc@gmail.com",
        phoneNumber: shopifyOrder.shipping_address?.phone || "0000000000",
        address: shopifyOrder.shipping_address?.address1 || "abc,abc,abc",
        pinCode: shopifyOrder.shipping_address?.zip || "000000",
        city: shopifyOrder.shipping_address?.city || "abc",
        state: shopifyOrder.shipping_address?.province || "abc",
      },
      productDetails,
      packageDetails: {
        deadWeight: totalWeight,
        applicableWeight: totalWeight,
        volumetricWeight: {
          length: totalLength,
          width: totalWidth,
          height: totalHeight,
        },
      },
      paymentDetails: {
        method: shopifyOrder.financial_status === "paid" ? "Prepaid" : "COD",
        amount:
          shopifyOrder.financial_status === "paid"
            ? 0
            : parseFloat(shopifyOrder.total_price) || 0,
      },
      status: "new",
      tracking: [
        {
          status: "new",
          StatusLocation: shopifyOrder.shipping_address?.city || "N/A",
          StatusDateTime: new Date(),
          Instructions: "Order synced from Shopify",
        },
      ],
    });

    await newOrder.save();

    res.status(200).json({
      message: "Order synced successfully",
      orderId: newOrder.orderId,
    });
  } catch (error) {
    console.error("Error syncing Shopify order:", error.response?.data || error.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// ✅ Store Channel Details and Register Webhook
const storeAllChannelDetails = async (req, res) => {
  try {
    console.log("📦 Received Store Data:", req.body);
    const userId = req.user?._id;

    const {
      channel,
      storeName,
      storeURL: rawStoreURL,
      storeClientId,
      storeClientSecret,
      storeAccessToken,
      orderSyncFrequency,
      paymentStatusCOD,
      paymentStatusPrepaid,
      multiSeller,
      syncInventory,
      syncDate,
    } = req.body;
    // console.log("req",req.body)

    // Normalize what the seller typed into the bare canonical domain (strip
    // protocol/trailing slash, lowercase, trim whitespace) so the saved
    // storeURL always matches the exact string Shopify sends back in the
    // x-shopify-shop-domain header on every webhook call. Without this, a
    // stray trailing slash or copy-pasted "https://" silently breaks
    // inbound order sync forever even though the store connects fine.
    let storeURL = (rawStoreURL || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "")
      .toLowerCase();

    if (
      !storeName ||
      !storeURL ||
      !storeClientId ||
      !storeClientSecret
      // !storeAccessToken
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    const existingStore = await AllChannel.findOne({ storeURL });
    if (existingStore) {
      return res.status(400).json({ message: "Store URL already exists" });
    }

    // ✅ Generate the Shopify access token ourselves from the Client
    // ID/Secret the seller provides — a Custom App's token is a Client
    // Credentials grant we can request directly, so there's no reason to
    // ask the seller to separately generate and paste one in (and it's
    // short-lived anyway, see getValidShopifyAccessToken).
    let shopifyAccessToken;
    let shopifyAccessTokenExpiresAt;
    if (channel === "Shopify") {
      // Sellers mix up which field holds the actual shop handle — some paste
      // it into Store Name and leave an unrelated/stale value in Store URL
      // (or a browser-copied admin.shopify.com/store/<handle> link). Resolve
      // both fields to canonical myshopify domains and try Store URL first,
      // falling back to Store Name before giving up, so a mislabeled field
      // doesn't block the connection.
      const primaryDomain = normalizeShopifyStoreURL(storeURL);
      const candidateDomains = [primaryDomain];
      const storeNameDomain = normalizeShopifyStoreURL(storeName);
      if (storeNameDomain && storeNameDomain !== primaryDomain) {
        candidateDomains.push(storeNameDomain);
      }

      let tokenErr;
      for (const domain of candidateDomains) {
        try {
          const tokenResult = await generateShopifyAccessToken(domain, storeClientId, storeClientSecret);
          shopifyAccessToken = tokenResult.accessToken;
          shopifyAccessTokenExpiresAt = tokenResult.expiresAt;
          storeURL = domain;
          tokenErr = null;
          break;
        } catch (err) {
          tokenErr = err;
        }
      }

      if (tokenErr) {
        console.error("❌ Failed to generate Shopify access token:", tokenErr.response?.data || tokenErr.message);
        return res.status(400).json({
          success: false,
          message: "Failed to authenticate with Shopify using the provided Store URL, Client ID, and Client Secret. Please verify these are correct.",
          error: tokenErr.response?.data || tokenErr.message,
        });
      }
    }

    // ✅ Register Webhook
    // Webhook registration must fully succeed before we save the channel —
    // saving a channel with no webhookId leaves it looking "connected" while
    // no webhook actually exists on the store, so orders silently never sync.
    let webHook;
    let webhookId;
    if (channel === "Shopify") {
      webHook = await createWebhook(storeURL, shopifyAccessToken);
      console.log("✅ Webhook response:", webHook);
      if (webHook?.error) {
        console.error("❌ Shopify webhook registration failed:", webHook.error);
        return res.status(400).json({
          success: false,
          message: "Failed to register the Shopify webhook. Please check your Store URL, Client ID, and Client Secret.",
          error: webHook.error,
        });
      }
      webhookId = webHook?.webhook?.id;
    }
    if (channel === "WooCommerce") {
      try {
        webHook = await createWooCommerceWebhook(
          storeURL,
          storeClientId,
          storeClientSecret
        );
      } catch (wcErr) {
        console.error("❌ WooCommerce webhook registration failed:", wcErr.message);
        return res.status(400).json({
          success: false,
          message: "Failed to register the WooCommerce webhook. Please check your Store URL, Consumer Key, and Consumer Secret.",
          error: wcErr.message,
        });
      }
      webhookId = webHook?.id || webHook?.webhook?.id;
    }
    if (!webhookId) {
      console.error(`❌ ${channel} webhook call succeeded but returned no webhook id:`, webHook);
      return res.status(400).json({
        success: false,
        message: `${channel} did not return a webhook ID — the store was not connected. Please verify your credentials and try again.`,
      });
    }
    const newChannel = new AllChannel({
      userId,
      channel,
      storeName,
      storeURL,
      storeClientId,
      storeClientSecret,
      // WooCommerce still uses whatever the seller pasted in (its Consumer
      // Key/Secret double as the credential directly, no token-exchange
      // step); Shopify always uses the token we just generated ourselves.
      storeAccessToken: channel === "Shopify" ? shopifyAccessToken : storeAccessToken,
      storeAccessTokenExpiresAt: channel === "Shopify" ? shopifyAccessTokenExpiresAt : undefined,
      orderSyncFrequency,
      paymentStatus: {
        COD: paymentStatusCOD || "",
        Prepaid: paymentStatusPrepaid || "",
      },
      multiSeller,
      syncInventory,
      syncFromDate: syncDate || null,
      webhookId: webhookId,
      // Only set for a freshly-created WooCommerce webhook — absent if the
      // webhook already existed (WooCommerce doesn't return secrets for
      // pre-existing webhooks) or for Shopify (uses storeClientSecret instead).
      webhookSecret: webHook?.secret || undefined,
    });

    await newChannel.save();

    return res.status(201).json({
      success: true,
      message: "Channel details stored successfully.",
      data: newChannel,
    });
  } catch (error) {
    console.error("❌ Error storing channel details:", error.response?.data || error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error." });
  }
};


// Shopify's payment_gateway_names holds human-readable gateway labels (e.g.
// "Cash on Delivery (COD)", "UPI", "Manual") — never the snake_case
// "cash_on_delivery" this used to look for, so it never matched a real COD
// gateway. That silently misclassified genuine COD orders (whose
// financial_status legitimately stays "pending" until delivery) as unpaid
// prepaid orders and skipped fulfilling them.
const isShopifyCodOrder = (paymentGatewayNames) =>
  (paymentGatewayNames || []).some((name) => /cash.?on.?delivery|\bcod\b/i.test(name));

// Shopify fulfillment events only accept this fixed vocabulary — there's no
// native "RTO" concept, so RTO/undelivered/lost map to "failure" with the
// real Shiproxx status preserved in the order's tracking history (not lost,
// just not representable as a distinct Shopify fulfillment event).
const shiproxxToShopifyFulfillmentEvent = (shiproxxStatus) => {
  const map = {
    "In-transit": "in_transit",
    "Out for Delivery": "out_for_delivery",
    "Delivered": "delivered",
    "Undelivered": "failure",
    "Lost": "failure",
    "RTO": "failure",
    "RTO In-transit": "failure",
    "RTO Delivered": "failure",
  };
  return map[shiproxxStatus] || null;
};

// Bulk-booking a batch of orders fires one of these push-backs per order
// nearly simultaneously (fire-and-forget, no queueing), which easily blows
// through Shopify's Admin API rate limit (429) — and until now, a single
// throttled request meant that order's fulfillment was silently dropped
// forever, with no retry. Retries a handful of times on 429/5xx/network
// errors, honoring Shopify's own Retry-After header when present.
const SHOPIFY_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const shopifySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shopifyRequestWithRetry = async (requestFn, attempts = 4) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      const status = err.response?.status;
      const isLastAttempt = attempt === attempts - 1;
      if (!SHOPIFY_RETRYABLE_STATUS.has(status) && status !== undefined) throw err; // non-retryable (4xx validation etc.)
      if (isLastAttempt) throw err;
      const retryAfterSec = Number(err.response?.headers?.["retry-after"]);
      const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : 500 * 2 ** attempt; // 500ms, 1s, 2s fallback backoff
      await shopifySleep(delayMs);
    }
  }
};

// Auto-triggered Shopify status/tracking push-back — the Shopify analogue of
// markWooOrderAsShipped (Channels/WooCommerce/woocommerce.controller.js).
// Called from Orders/tracking.controller.js and the courier webhook
// controllers whenever an order's status changes, gated on
// order.channel === "Shopify". Unlike WooCommerce (a simple order-status
// field), Shopify's model is: create one Fulfillment on first shipment scan,
// then post Fulfillment Events for subsequent status changes.
const markShopifyOrderAsShipped = async (
  storeUrl,
  orderId,
  trackingNumber,
  courierName,
  shiproxxStatus,
  notifyCustomer = true
) => {
  try {
    const store = await AllChannel.findOne({
      storeURL: { $regex: storeUrl.replace(/\/$/, ""), $options: "i" },
      channel: "Shopify",
    });
    if (!store) {
      console.error(`❌ Shopify store not found for URL: ${storeUrl}`);
      return;
    }

    const dbOrder = await Order.findOne({
      $or: [{ orderId }, { channelId: orderId }],
    });
    if (dbOrder && dbOrder.channel && dbOrder.channel !== "Shopify") {
      console.error(`❌ Order ${orderId} is a ${dbOrder.channel} order, not Shopify. Push-back skipped.`);
      return;
    }

    const shopifyOrderId = dbOrder?.channelId;
    if (!shopifyOrderId) {
      console.error(`❌ No Shopify order id (channelId) found for order ${orderId}. Push-back skipped.`);
      return;
    }

    const accessToken = await getValidShopifyAccessToken(store);
    const baseUrl = `https://${store.storeURL}/admin/api/2024-04`;
    const authHeaders = { headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" } };

    let shopifyOrder;
    try {
      const response = await shopifyRequestWithRetry(() =>
        axios.get(`${baseUrl}/orders/${shopifyOrderId}.json`, authHeaders)
      );
      shopifyOrder = response.data.order;
    } catch (err) {
      console.error(`❌ Error fetching Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
      return;
    }

    // Shopify never removes a cancelled fulfillment from this array — it
    // just sits there with status "cancelled" once the original courier
    // attempt is cancelled (e.g. re-booking with a different courier after
    // a failed pickup). Treating that stale entry as "a fulfillment already
    // exists" meant a re-booked shipment's new AWB never got pushed at all:
    // every later status change just tried (and failed) to post an event to
    // the dead cancelled fulfillment, leaving the order permanently
    // unfulfilled on Shopify. Only a live (non-cancelled) fulfillment counts
    // as "existing" here.
    const existingFulfillment = (shopifyOrder.fulfillments || []).find(
      (f) => f.status !== "cancelled"
    );

    // --- First shipment scan: create the fulfillment ---
    if (!existingFulfillment) {
      // Anything before booking, or a cancelled order, has nothing to
      // fulfill. Every other status — including a status that's already
      // progressed well past "Booked" (e.g. a backfill call for an order
      // that's already Delivered, or a courier whose very first webhook
      // update skips straight to a later stage) — should still get a
      // fulfillment created now rather than being silently skipped, since
      // relying on a status landing exactly on "Booked"/"Ready To
      // Ship"/"Pickup Completed" made this permanently miss orders whose
      // first-ever update arrived at any other stage.
      const NON_FULFILLABLE_STATUSES = ["new", "processing", "Cancelled"];
      if (NON_FULFILLABLE_STATUSES.includes(shiproxxStatus)) {
        console.log(`ℹ️ Shiproxx status "${shiproxxStatus}" doesn't warrant creating a Shopify fulfillment yet — skipping.`);
        return;
      }
      if (shopifyOrder.fulfillment_status === "fulfilled") return; // already fulfilled elsewhere

      // A prepaid order whose Shopify financial_status is still "pending"
      // shouldn't get fulfilled at the moment it's JUST been booked — give
      // Shopify's own payment webhook a chance to catch up first. But this
      // must NOT apply once the shipment has already progressed past that
      // point (In-transit, Out for Delivery, Delivered, ...): since no
      // fulfillment exists yet (`!existingFulfillment`, the branch we're in),
      // every later status change re-enters this exact same check and would
      // otherwise re-skip forever — permanently blocking the fulfillment for
      // an order that has demonstrably already shipped in the real world,
      // regardless of what Shopify's financial_status says. Confirmed via a
      // live audit against real orders (#VN54768: In-transit in Shiproxx,
      // fulfillment_status stuck null on Shopify because of exactly this).
      const isCOD = isShopifyCodOrder(shopifyOrder.payment_gateway_names);
      const hasAdvancedPastBooking = !!shiproxxToShopifyFulfillmentEvent(shiproxxStatus);
      if (!isCOD && !hasAdvancedPastBooking && shopifyOrder.financial_status === "pending") {
        console.log(`ℹ️ Shopify order ${shopifyOrderId} not fulfilled — payment still pending.`);
        return;
      }

      // Shopify deprecated POST /orders/{id}/fulfillments.json (it now
      // returns 406 under current API versions) in favor of the
      // FulfillmentOrder-based flow: look up the order's open fulfillment
      // order(s), then create the fulfillment against that, with no
      // location_id needed — the fulfillment order already carries it.
      let fulfillmentOrderId;
      try {
        const foRes = await shopifyRequestWithRetry(() =>
          axios.get(`${baseUrl}/orders/${shopifyOrderId}/fulfillment_orders.json`, authHeaders)
        );
        const fulfillmentOrders = foRes.data?.fulfillment_orders || [];
        const openFulfillmentOrder = fulfillmentOrders.find((fo) => fo.status === "open") || fulfillmentOrders[0];
        fulfillmentOrderId = openFulfillmentOrder?.id;
      } catch (err) {
        console.error(`❌ Error fetching fulfillment orders for ${shopifyOrderId}:`, err.response?.data || err.message);
        return;
      }
      if (!fulfillmentOrderId) {
        console.error(`❌ No fulfillment order found for Shopify order ${shopifyOrderId}.`);
        return;
      }

      let newFulfillmentId;
      try {
        const fulfillRes = await shopifyRequestWithRetry(() =>
          axios.post(
            `${baseUrl}/fulfillments.json`,
            {
              fulfillment: {
                notify_customer: notifyCustomer,
                tracking_info: {
                  number: trackingNumber,
                  company: courierName,
                  url: `https://www.shiproxx.com/track/${trackingNumber}`,
                },
                line_items_by_fulfillment_order: [
                  { fulfillment_order_id: fulfillmentOrderId },
                ],
              },
            },
            authHeaders
          )
        );
        newFulfillmentId = fulfillRes.data?.fulfillment?.id;
        console.log(`✅ Shopify order ${shopifyOrderId} fulfilled (${shiproxxStatus}).`);
      } catch (err) {
        console.error(`❌ Error creating fulfillment for Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
        return;
      }

      // If the order has already progressed past "just booked" (e.g. this
      // IS the backfill call for an already-Delivered order), immediately
      // post the matching fulfillment event too — otherwise Shopify stays
      // parked at the initial "fulfilled" state forever, since there's no
      // future status change left to trigger the update.
      const initialEventStatus = shiproxxToShopifyFulfillmentEvent(shiproxxStatus);
      if (newFulfillmentId && initialEventStatus) {
        try {
          await shopifyRequestWithRetry(() =>
            axios.post(
              `${baseUrl}/fulfillments/${newFulfillmentId}/events.json`,
              { event: { status: initialEventStatus } },
              authHeaders
            )
          );
          console.log(`✅ Shopify fulfillment ${newFulfillmentId} event posted: ${shiproxxStatus} → ${initialEventStatus}`);
        } catch (err) {
          console.error(`❌ Error posting initial fulfillment event for Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
        }
      }
      return;
    }

    // --- Fulfillment already exists: cancel or post a status event ---
    if (shiproxxStatus === "Cancelled") {
      try {
        await shopifyRequestWithRetry(() =>
          axios.post(`${baseUrl}/fulfillments/${existingFulfillment.id}/cancel.json`, {}, authHeaders)
        );
        console.log(`✅ Shopify fulfillment ${existingFulfillment.id} cancelled.`);
      } catch (err) {
        console.error(`❌ Error cancelling Shopify fulfillment ${existingFulfillment.id}:`, err.response?.data || err.message);
      }
      return;
    }

    const eventStatus = shiproxxToShopifyFulfillmentEvent(shiproxxStatus);
    if (!eventStatus) {
      console.log(`ℹ️ No Shopify fulfillment-event mapping for status "${shiproxxStatus}" — skipping.`);
      return;
    }

    try {
      await shopifyRequestWithRetry(() =>
        axios.post(
          `${baseUrl}/fulfillments/${existingFulfillment.id}/events.json`,
          { event: { status: eventStatus } },
          authHeaders
        )
      );
      console.log(`✅ Shopify fulfillment ${existingFulfillment.id} event posted: ${shiproxxStatus} → ${eventStatus}`);
    } catch (err) {
      console.error(`❌ Error posting fulfillment event for Shopify order ${shopifyOrderId}:`, err.response?.data || err.message);
    }
  } catch (err) {
    console.error("❌ Unexpected error in markShopifyOrderAsShipped:", err.message);
  }
};

const fulfillOrder = async (req, res) => {
  try {
    console.log("body", req.body);
    const { id, provider, awb_number } = req.body;
    console.log("Received fulfillment request:", {
      id,
      provider,
      awb_number,
    });

    if (!id || !provider || !awb_number) {
      return res.status(400).json({
        message: "Missing required fields: orderId, provider, waybill",
      });
    }

    const userId = req.user._id;
    const channel = await AllChannel.findOne({
      userId: userId,
      channel: "Shopify",
    });

    if (!channel) {
      return res
        .status(404)
        .json({ message: "Shopify channel not found for this user" });
    }

    const shopifyStore = channel.storeURL;
    let accessToken;
    try {
      accessToken = await getValidShopifyAccessToken(channel);
    } catch (tokenErr) {
      console.error("Error obtaining Shopify access token:", tokenErr.response?.data || tokenErr.message);
      return res.status(500).json({ message: "Failed to authenticate with Shopify" });
    }

    // Fetch order details
    let orderDetails;
    try {
      const orderResponse = await axios.get(
        `https://${shopifyStore}/admin/api/2024-04/orders/${id}.json`,
        {
          headers: { "X-Shopify-Access-Token": accessToken },
        }
      );
      orderDetails = orderResponse.data.order;
    } catch (error) {
      console.error(
        "Error fetching order details:",
        error.response?.data || error
      );
      return res.status(404).json({ message: "Order not found on Shopify" });
    }

    console.log("Order details:", orderDetails);

    // Check if the order is already fulfilled
    if (orderDetails.fulfillment_status === "fulfilled") {
      return res.status(400).json({ message: "Order is already fulfilled" });
    }

    // Check if the order is a COD order
    const isCOD = isShopifyCodOrder(orderDetails.payment_gateway_names);

    // If the order is not COD and payment is still pending, do not fulfill
    if (!isCOD && orderDetails.financial_status === "pending") {
      console.log("not fulfilled");
      return res.status(400).json({
        message: "Order cannot be fulfilled as payment is still pending.",
      });
    }

    // Fetch store locations
    // Shopify deprecated POST /orders/{id}/fulfillments.json (it now
    // returns 406 under current API versions) in favor of the
    // FulfillmentOrder-based flow — see markShopifyOrderAsShipped above for
    // the same fix applied to the automatic push-back path.
    let fulfillmentOrderId;
    try {
      const foRes = await axios.get(
        `https://${shopifyStore}/admin/api/2024-04/orders/${id}/fulfillment_orders.json`,
        { headers: { "X-Shopify-Access-Token": accessToken } }
      );
      const fulfillmentOrders = foRes.data?.fulfillment_orders || [];
      const openFulfillmentOrder = fulfillmentOrders.find((fo) => fo.status === "open") || fulfillmentOrders[0];
      fulfillmentOrderId = openFulfillmentOrder?.id;
    } catch (error) {
      console.error("Error fetching fulfillment orders:", error.response?.data || error.message);
      return res
        .status(500)
        .json({ message: "Error fetching fulfillment orders from Shopify" });
    }

    if (!fulfillmentOrderId) {
      return res
        .status(400)
        .json({ message: "No fulfillment order found for this Shopify order" });
    }

    // Fulfill the order
    try {
      const fulfillmentResponse = await axios.post(
        `https://${shopifyStore}/admin/api/2024-04/fulfillments.json`,
        {
          fulfillment: {
            notify_customer: true, // Notify customer via email
            tracking_info: {
              number: awb_number,
              company: provider,
              url: `https://www.shiproxx.com/track/${awb_number}`, // Adjust based on courier tracking link
            },
            line_items_by_fulfillment_order: [
              { fulfillment_order_id: fulfillmentOrderId },
            ],
          },
        },
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("Order Fulfilled:", fulfillmentResponse.data);

      return res.status(200).json({
        message: "Order fulfilled successfully",
        trackingInfo: {
          trackingNumber: awb_number,
          courier: provider,
          trackingURL: `https://www.shiproxx.com/track/${awb_number}`, // Adjust for your provider
        },
      });
    } catch (error) {
      console.error("Error fulfilling order:", error.response?.data || error.message);
      return res.status(500).json({
        message: "Error fulfilling order on Shopify",
        error: error.response?.data,
      });
    }
  } catch (error) {
    console.error("Unexpected error in fulfillOrder:", error.response?.data || error.message);
    return res.status(500).json({ message: "Internal server error", error: error.response?.data || error.message });
  }
};

// Example Usage
// fulfillOrder("1234567890", "TRK123456", "Ecom Express");

const getAllChannel = async (req, res) => {
  try {
    const userId = req.user._id;
    const allChannels = await AllChannel.find({ userId: userId });
    res.status(200).json({ success: true, data: allChannels });
  } catch (error) {
    console.error("Error fetching channels:", error.message);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const getOneChannel = async (req, res) => {
  const { id } = req.params;

  try {
    const channel = await AllChannel.findOne({ _id: id });
    // console.log("channel",channel)

    if (!channel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    res.status(200).json(channel);
  } catch (error) {
    console.error("Error fetching channel:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

const updateChannel = async (req, res) => {
  const { id } = req.params;
  let updatedData = { ...req.body };

  // Convert syncDate to Date object if provided
  if (req.body.syncDate) {
    updatedData.syncFromDate = new Date(req.body.syncDate);
  }

  try {
    // Check if the channel exists
    const existingChannel = await AllChannel.findById(id);
    if (!existingChannel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    // Same normalization as storeAllChannelDetails — an edited storeURL must
    // stay in the bare canonical domain form or inbound webhook lookups
    // break. For Shopify, also resolve admin.shopify.com links / bare
    // handles to the canonical <handle>.myshopify.com API host.
    if (typeof updatedData.storeURL === "string") {
      const channelType = updatedData.channel || existingChannel.channel;
      updatedData.storeURL = channelType === "Shopify"
        ? normalizeShopifyStoreURL(updatedData.storeURL)
        : updatedData.storeURL.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    }

    // Update the channel details
    let updatedChannel = await AllChannel.findByIdAndUpdate(
      id,
      { $set: updatedData }, // Ensure syncDate is properly formatted
      { new: true } // Return the updated document
    );

    // (Re-)register the webhook using whatever credentials are now on the
    // document — updating a channel's credentials previously just patched
    // the DB with no attempt to actually verify/register anything with
    // Shopify/WooCommerce, so a corrected token could be saved while
    // webhookId silently stayed empty and orders kept not syncing.
    let webhookStatus = "skipped";
    let webhookError = null;

    if (updatedChannel.channel === "Shopify") {
      let freshToken;
      try {
        // Reuses the still-valid stored token, or regenerates it from
        // whatever Client ID/Secret now sit on the document (e.g. the
        // seller just corrected them) — the seller never needs to supply
        // an access token here either.
        freshToken = await getValidShopifyAccessToken(updatedChannel);
      } catch (tokenErr) {
        webhookStatus = "failed";
        webhookError = tokenErr.response?.data || tokenErr.message;
        console.error(`❌ Failed to obtain Shopify access token for channel ${id}:`, webhookError);
      }

      if (freshToken) {
        const webHook = await createWebhook(updatedChannel.storeURL, freshToken);
        if (webHook?.error) {
          webhookStatus = "failed";
          webhookError = webHook.error;
          console.error(`❌ Shopify webhook (re-)registration failed for channel ${id}:`, webHook.error);
        } else if (webHook?.webhook?.id) {
          updatedChannel = await AllChannel.findByIdAndUpdate(
            id,
            { $set: { webhookId: webHook.webhook.id } },
            { new: true }
          );
          webhookStatus = "ok";
        } else {
          webhookStatus = "failed";
          webhookError = "Shopify returned no webhook id.";
          console.error(`❌ Shopify webhook call for channel ${id} returned no id:`, webHook);
        }
      }
    } else if (updatedChannel.channel === "WooCommerce") {
      try {
        const webHook = await createWooCommerceWebhook(
          updatedChannel.storeURL,
          updatedChannel.storeClientId,
          updatedChannel.storeClientSecret
        );
        const webhookId = webHook?.id || webHook?.webhook?.id;
        if (webhookId) {
          updatedChannel = await AllChannel.findByIdAndUpdate(
            id,
            { $set: { webhookId, ...(webHook?.secret ? { webhookSecret: webHook.secret } : {}) } },
            { new: true }
          );
          webhookStatus = "ok";
        } else {
          webhookStatus = "failed";
          webhookError = "WooCommerce returned no webhook id.";
          console.error(`❌ WooCommerce webhook call for channel ${id} returned no id:`, webHook);
        }
      } catch (wcErr) {
        webhookStatus = "failed";
        webhookError = wcErr.message;
        console.error(`❌ WooCommerce webhook (re-)registration failed for channel ${id}:`, wcErr.message);
      }
    }

    res.status(200).json({
      message: "Channel updated successfully",
      channel: updatedChannel,
      webhookStatus, // "ok" | "failed" | "skipped" (skipped = not Shopify/WooCommerce)
      webhookError,
    });
  } catch (error) {
    console.error("Error updating channel:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

const deleteChannel = async (req, res) => {
  const { id } = req.params;

  try {
    // Find and delete the channel
    const deletedChannel = await AllChannel.findByIdAndDelete(id);

    if (!deletedChannel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    res.status(200).json({ message: "Channel deleted successfully" });
  } catch (error) {
    console.error("Error deleting channel:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = {
  storeAllChannelDetails,
  webhookhandler,
  getAllChannel,
  getOneChannel,
  updateChannel,
  deleteChannel,
  fulfillOrder,
  fetchExistingOrders,
  createWebhook,
  markShopifyOrderAsShipped,
};
