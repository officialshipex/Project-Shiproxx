const axios = require("axios");
const crypto = require("crypto");
const Order = require("../../models/newOrder.model");
const { generateUniqueOrderIds } = require("../../utils/generateUniqueOrderId");
const AllChannel = require("../allChannel.model");
const PickupAddress = require("../../models/pickupAddress.model");

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

// Helper to extract HSN code from WooCommerce metadata
const extractHSN = (metaDataArray) => {
  if (!Array.isArray(metaDataArray)) return null;
  const hsnKeys = ["hsn_code", "hsn", "_hsn_code", "_hsn", "gst_hsn_code", "hs_code"];
  for (const item of metaDataArray) {
    if (item && item.key && hsnKeys.includes(item.key.toLowerCase())) {
      return String(item.value || "").trim();
    }
  }
  return null;
};

// const storeURL = "https://www.mahadevrediments.in/";
// const consumerKey = "ck_167c49505d20d4ec91bc4bb73459df2c4e7fc489";
// const consumerSecret = "cs_e479f1773fc3fc267c0ca01ce1845405d8c5ff66";

// Function to fetch orders from WooCommerce
const fetchWooCommerceOrders = async (
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    const response = await axios.get(`${storeURL}/wp-json/wc/v3/orders`, {
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
    });

    return response.data; // Returns orders from WooCommerce
  } catch (error) {
    console.error(
      "Error fetching WooCommerce orders:",
      error.response?.data || error
    );
    throw new Error("Failed to fetch orders from WooCommerce.");
  }
};
// fetchWooCommerceOrders(storeURL,consumerKey,consumerSecret)
// Payment method mapping
function mapWCPayment(method, methodTitle) {
  if (
    ["COD", "Cash on Delivery", "cash_on_delivery"].includes(method) ||
    /cod/i.test(method) ||
    /cash on delivery/i.test(methodTitle)
  )
    return "COD";
  return "Prepaid";
}

// Validate a WooCommerce webhook's HMAC SHA256 signature against the store's
// own webhook secret (captured at webhook-creation time — see
// createWooCommerceWebhook). Returns "valid" | "invalid" | "unverifiable"
// ("unverifiable" means we have no secret on file for this store, e.g. it
// was connected before webhookSecret existed — callers should treat that as
// fail-open, not reject, so pre-existing connections keep working).
function verifyWooCommerceSignature(req, webhookSecret) {
  if (!webhookSecret) return "unverifiable";
  const signature = req.headers["x-wc-webhook-signature"];
  if (!signature || !req.rawBody) return "invalid";
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(req.rawBody)
    .digest("base64");
  try {
    const expectedBuf = Buffer.from(expected, "base64");
    const signatureBuf = Buffer.from(signature, "base64");
    if (expectedBuf.length !== signatureBuf.length) return "invalid";
    return crypto.timingSafeEqual(expectedBuf, signatureBuf) ? "valid" : "invalid";
  } catch (err) {
    return "invalid";
  }
}
//webhook creation
const checkExistingWooCommerceWebhooks = async (
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    const response = await axios.get(`${storeURL}/wp-json/wc/v3/webhooks`, {
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
    });

    return response.data; // Returns all existing webhooks
  } catch (error) {
    console.error(
      "❌ Error fetching WooCommerce webhooks:",
      error.response?.data || error
    );
    return [];
  }
};

const createWooCommerceWebhook = async (
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    // 🔍 Step 1: Check if a webhook already exists
    const existingWebhooks = await checkExistingWooCommerceWebhooks(
      storeURL,
      consumerKey,
      consumerSecret
    );

    // 🔄 Step 2: Filter Webhooks for our "Order Created" event
    const existingWebhook = existingWebhooks.find(
      (webhook) =>
        webhook.topic.includes("order") &&
        webhook.delivery_url ===
        "https://api.shiproxx.com/v1/channel/webhook/woocommerce"
    );

    if (existingWebhook) {
      console.log("✅ Webhook already exists:", existingWebhook);
      // WooCommerce never returns a webhook's secret outside of creation, so
      // a pre-existing webhook has no recoverable secret — the caller will
      // store webhookSecret as undefined, and signature checks fail open
      // for this store until it's disconnected/reconnected.
      return existingWebhook;
    }

    // 🚀 Step 3: Create new webhook if none exists.
    // We generate and supply our own secret (rather than relying on
    // WooCommerce's auto-generated one) so we always know it deterministically.
    const webhookSecret = crypto.randomBytes(32).toString("hex");
    const response = await axios.post(
      `${storeURL}/wp-json/wc/v3/webhooks`,
      {
        name: "Order Created Webhook",
        topic: "order.created",
        delivery_url:
          "https://api.shiproxx.com/v1/channel/webhook/woocommerce",
        status: "active",
        secret: webhookSecret,
      },
      {
        auth: {
          username: consumerKey,
          password: consumerSecret,
        },
      }
    );

    console.log("✅ Webhook created successfully:", response.data);
    return { ...response.data, secret: webhookSecret }; // Return newly created webhook details + the secret we set
  } catch (error) {
    console.error(
      "❌ Error creating WooCommerce webhook:",
      error.response?.data || error
    );
    throw new Error("Failed to create WooCommerce webhook.");
  }
};

//webhook handler

// Generate unique 6-digit ID with DB check
const generateUniqueOrderId = async () => {
  const orderId = await generateUniqueOrderIds(1);
  return orderId.toString();
};

const wooCommerceWebhookHandler = async (req, res) => {
  try {
    const orderData = req.body;
    console.log("orderData for Woo commerce", req.body);

    // Extract store URL from body or header
    const storeURL = orderData.store_url || req.headers["x-wc-webhook-source"];
    console.log("req headers", req.headers["x-wc-webhook-source"]);
    if (!storeURL) {
      return res.status(400).json({ error: "Missing store URL in webhook" });
    }

    // Find store in DB
    const store = await AllChannel.findOne({ storeURL });
    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    // Verify webhook signature when we have a secret on file for this store.
    // Stores connected before webhookSecret existed (or whose webhook already
    // existed at connect time) have no secret to check against — fail open
    // for those rather than silently breaking their existing sync.
    const signatureResult = verifyWooCommerceSignature(req, store.webhookSecret);
    if (signatureResult === "invalid") {
      console.warn(`❌ WooCommerce webhook signature mismatch for store ${storeURL}`);
      return res.status(401).json({ error: "Invalid webhook signature" });
    }
    if (signatureResult === "unverifiable") {
      console.warn(`⚠️ No webhook secret on file for store ${storeURL} — processing unverified (reconnect the store to enable signature verification).`);
    }

    // Dedup up front using WooCommerce's own order id, before doing any of
    // the (relatively expensive) per-line-item product lookups below.
    const compositeOrderId = `${storeURL}-${orderData.id}`;
    const existingOrder = await Order.findOne({ compositeOrderId });
    if (existingOrder) {
      console.log(`Order ${compositeOrderId} already exists, skipping...`);
      return res.status(200).json({ message: "Duplicate order ignored" });
    }

    // Product details + weight/dimensions aggregation
    let totalWeight = 0.5;
    let totalLength = 10,
      totalWidth = 10,
      totalHeight = 10;

    const productDetails = await Promise.all(
      (orderData.line_items || []).map(async (item) => {
        const productInfo = await getWooCommerceProductDetails(
          item.product_id,
          storeURL,
          store.storeClientId,
          store.storeClientSecret
        );

        totalWeight +=
          (parseFloat(productInfo.weight) || 0) * (item.quantity || 0);
        totalLength = Math.max(
          totalLength,
          parseFloat(productInfo.length) || 10
        );
        totalWidth = Math.max(totalWidth, parseFloat(productInfo.width) || 10);
        totalHeight = Math.max(
          totalHeight,
          parseFloat(productInfo.height) || 10
        );

        const total = parseFloat(item.total) || 0;
        const totalTax = parseFloat(item.total_tax) || 0;
        const subtotal = parseFloat(item.subtotal) || 0;
        const subtotalTax = parseFloat(item.subtotal_tax) || 0;
        const qty = parseInt(item.quantity) || 1;

        // Calculate inclusive unit price (using subtotal to get the original price before discounts)
        const unitPriceInclTax = (subtotal + subtotalTax) / qty;

        // Calculate discount per unit (if any)
        const discountInclTax = (subtotal + subtotalTax - total - totalTax) / qty;

        // Check line_item meta_data first, fallback to fetched product meta_data
        const itemHsn = extractHSN(item.meta_data) || productInfo.hsn || "";

        const productRow = {
          id: item.product_id,
          quantity: qty,
          name: item.name,
          unitPrice: unitPriceInclTax.toFixed(2),
          discount: discountInclTax > 0 ? discountInclTax.toFixed(2) : "0",
          sku: item.sku,
          tax: String(totalTax),
          hsn: itemHsn,
        };

        console.log(`Synced Product: ${item.name} | UnitPrice(Incl.Tax): ${productRow.unitPrice} | Discount: ${productRow.discount}`);
        return productRow;
      })
    );

    // Our internal unique orderId
    const internalOrderId = await generateUniqueOrderId();
    // Map payment details
    const paymentMethod = mapWCPayment(
      orderData.payment_method,
      orderData.payment_method_title
    );
    const paymentDetails = {
      method: paymentMethod,
      amount: parseFloat(orderData.total) || 0,
    };

    // Fetch primary pickup address for this user. If none is configured,
    // fall back to a placeholder rather than dropping the order — the seller
    // can see it landed and fix their pickup address afterward.
    const primaryPickup = await PickupAddress.findOne({
      userId: store.userId,
      isPrimary: true
    }).lean();

    if (!primaryPickup || !primaryPickup.pickupAddress) {
      console.warn(`⚠️ No primary pickup address configured for user ${store.userId} — using placeholder pickup address for ${compositeOrderId}.`);
    }
    const pickupAddressData = primaryPickup?.pickupAddress || DUMMY_PICKUP_ADDRESS;

    const shipping = orderData.shipping || {};
    const billing = orderData.billing || {};

    // Prepare order payload
    const orderPayload = {
      userId: store.userId, // from the store record
      orderId: internalOrderId, // our own 6-digit ID
      compositeOrderId, // `${storeURL}-${WC order id}`, deduped upfront above
      channelId: orderData.id,
      channel: "WooCommerce",
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
        contactName: `${shipping.first_name || ""} ${shipping.last_name || ""}`.trim() || "N/A",
        email: billing.email || "unknown@example.com",
        phoneNumber: shipping.phone || billing.phone || "0000000000",
        address: shipping.address_1 || "Not Provided",
        pinCode: shipping.postcode || "000000",
        city: shipping.city || "Unknown",
        state: shipping.state || "Unknown",
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
      paymentDetails,
      status: "new",
      tracking: [
        {
          status: "new",
          StatusLocation: shipping.city || "N/A",
          StatusDateTime: new Date(),
          Instructions: "Order synced from WooCommerce",
        },
      ],
    };

    try {
      await Order.create(orderPayload);
      return res
        .status(200)
        .json({ message: "WooCommerce order synced successfully." });
    } catch (err) {
      if (err.code === 11000) {
        return res
          .status(200)
          .json({ message: "Duplicate: WooCommerce order already synced." });
      }
      throw err;
    }
  } catch (error) {
    console.error("Error syncing WooCommerce order:", error.response?.data || error.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

//product details

const getWooCommerceProductDetails = async (
  productId,
  storeURL,
  consumerKey,
  consumerSecret
) => {
  try {
    // Ensure no trailing slash in store URL
    const baseUrl = storeURL.replace(/\/$/, "");

    const response = await axios.get(
      `${baseUrl}/wp-json/wc/v3/products/${productId}`,
      {
        auth: {
          username: consumerKey,
          password: consumerSecret,
        },
      }
    );

    const product = response.data || {};
    console.log("product", response.data);
    const dimensions = product.dimensions || {};
    console.log("dimensions", dimensions);

    return {
      weight: parseFloat(product.weight) || 0.5,
      length: parseFloat(dimensions.length) || 10,
      width: parseFloat(dimensions.width) || 10,
      height: parseFloat(dimensions.height) || 10,
      sku: product.sku || null, // Optional extra
      price: product.price ? parseFloat(product.price) : null, // Optional extra
      hsn: extractHSN(product.meta_data),
    };
  } catch (error) {
    console.error(
      "Error fetching WooCommerce product details:",
      error.response?.data || error.message || error
    );
    return { weight: 0.5, length: 10, width: 10, height: 10 }; // couldn't reach WooCommerce for this product — same default used elsewhere
  }
};

// Map Shiproxx internal status → WooCommerce order status
// WooCommerce standard: pending, processing, on-hold, completed, cancelled
// Stores with shipment plugins may also accept: shipped, in-transit, out-for-delivery, etc.
const shiproxxToWooStatus = (shiproxxStatus) => {
  const map = {
    "Booked":           "ready-to-ship",
    "Ready To Ship":    "ready-to-ship",
    "Pickup Completed": "in-transit",
    "In-transit":       "in-transit",
    "Out for Delivery": "out-for-delivery",
    "Delivered":        "delivered",
    "Cancelled":        "cancelled",
    "RTO":              "refunded",
    "RTO In-transit":   "refunded",
    "RTO Delivered":    "refunded",
    "Undelivered":      "on-hold",
    "Lost":             "on-hold",
  };
  return map[shiproxxStatus] || null; // null = don't update WC status for unknown statuses
};

const markWooOrderAsShipped = async (
  storeUrl,
  orderId,
  trackingNumber,
  courierName,
  shiproxxStatus   // Shiproxx order status (e.g. "In-transit", "Delivered", "Booked")
) => {
  try {
    const baseUrl = storeUrl.replace(/\/$/, "");
    const store = await AllChannel.findOne({
      storeURL: { $regex: storeUrl.replace(/\/$/, ""), $options: "i" }
    });

    if (!store) {
      console.error(`❌ Store not found for URL: ${storeUrl}`);
      return;
    }

    // 3. Resolve channelId (WC's internal ID) if our internal 6-digit ID was provided
    let wcOrderId = orderId;
    const dbOrder = await Order.findOne({
      $or: [{ orderId: orderId }, { channelId: orderId }]
    });

    if (dbOrder && dbOrder.channel !== "WooCommerce") {
      console.error(`❌ Order ${orderId} is a ${dbOrder.channel} order, not a WooCommerce order. Fulfillment skipped.`);
      return;
    }

    if (dbOrder && dbOrder.channelId) {
      wcOrderId = dbOrder.channelId;
      console.log(`ℹ️ Resolved internal ID ${orderId} to WooCommerce ID ${wcOrderId}`);
    }

    // 4. Map Shiproxx status → WooCommerce status
    const wcStatus = shiproxxToWooStatus(shiproxxStatus);
    if (!wcStatus) {
      console.log(`ℹ️ No WooCommerce status mapping for Shiproxx status: "${shiproxxStatus}". Skipping WC update.`);
      return;
    }

    // 5. Fetch current WooCommerce order to avoid redundant updates
    let currentWCOrder;
    try {
      const response = await axios.get(`${baseUrl}/wp-json/wc/v3/orders/${wcOrderId}`, {
        auth: {
          username: store.storeClientId,
          password: store.storeClientSecret,
        },
      });
      currentWCOrder = response.data;
    } catch (err) {
      console.error(`❌ Error fetching WooCommerce order ${wcOrderId}:`, err.response?.data?.message || err.message);
      return;
    }

    const trackingUrl = `https://app.shiproxx.com/dashboard/order/tracking/${trackingNumber}`;
    const newNote = `Shiproxx Update: ${shiproxxStatus} | AWB: ${trackingNumber} | Courier: ${courierName || "N/A"}`;

    // 6. Update WooCommerce order status (only if status changed or note is different)
    if (currentWCOrder.status !== wcStatus || currentWCOrder.customer_note !== newNote) {
      try {
        await axios.put(
          `${baseUrl}/wp-json/wc/v3/orders/${wcOrderId}`,
          {
            status: wcStatus,
            customer_note: newNote,
          },
          {
            auth: {
              username: store.storeClientId,
              password: store.storeClientSecret,
            },
          }
        );
        console.log(`✅ WooCommerce order ${wcOrderId} updated: ${shiproxxStatus} → ${wcStatus}`);
      } catch (err) {
        console.error(`❌ Error updating status for WC order ${wcOrderId}:`, err.response?.data?.message || err.message);
      }
    } else {
      console.log(`ℹ️ WooCommerce order ${wcOrderId} already has status "${wcStatus}" and same note. Skipping status update.`);
    }

    // 7. Add tracking info to WooCommerce (only when Booked / first shipment scan)
    const addTrackingStatuses = ["Booked", "Ready To Ship", "Pickup Completed"];
    if (trackingNumber && addTrackingStatuses.includes(shiproxxStatus)) {
      try {
        // Check if tracking number is already added to avoid duplicates
        const trackingListResponse = await axios.get(
          `${baseUrl}/wp-json/wc-shipment-tracking/v3/orders/${wcOrderId}/shipment-trackings`,
          {
            auth: {
              username: store.storeClientId,
              password: store.storeClientSecret,
            },
          }
        );

        const existingTrackings = Array.isArray(trackingListResponse.data) ? trackingListResponse.data : [];
        const isAlreadyAdded = existingTrackings.some(t => t.tracking_number === trackingNumber);

        if (!isAlreadyAdded) {
          await axios.post(
            `${baseUrl}/wp-json/wc-shipment-tracking/v3/orders/${wcOrderId}/shipment-trackings`,
            {
              tracking_provider: courierName || "Custom Provider",
              tracking_number: trackingNumber,
              date_shipped: new Date().toISOString(),
              tracking_url: trackingUrl || "",
            },
            {
              auth: {
                username: store.storeClientId,
                password: store.storeClientSecret,
              },
            }
          );
          console.log(`🚚 Tracking info added for WooCommerce order ${wcOrderId}`);
        } else {
          console.log(`ℹ️ Tracking ${trackingNumber} already exists for WooCommerce order ${wcOrderId}. Skipping duplicate add.`);
        }
      } catch (err) {
        // If the tracking plugin is missing, it will return 404 or similar
        if (err.response?.status !== 404) {
          console.log(
            `⚠️ Could not manage tracking info for WC order ${wcOrderId}: ${err.response?.data?.message || err.message}`
          );
        }
      }
    }

    // 5. Trigger Notifications to Customer are now handled automatically by the Order model hook (post-save)
    // No manual calls needed here.
  } catch (error) {
    console.error(
      `❌ Error fulfilling WooCommerce order ${orderId}:`,
      error.response?.data || error.message
    );
  }
};

// markWooOrderAsShipped("https://shop.teamworkarts.com/","576643","QPSP0000000209","Ekart")

module.exports = {
  markWooOrderAsShipped,
  wooCommerceWebhookHandler,
  createWooCommerceWebhook
};
