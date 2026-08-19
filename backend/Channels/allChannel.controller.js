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
    console.error("Error creating webhook:", error.response?.data || error);
    return { error: error.response?.data || error.message };
  }
};

const getProductDetails = async (productId, storeURL, accessToken) => {
  try {
    const response = await axios.get(
      `https://${storeURL}/admin/api/2024-01/products/${productId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    // console.log("Product Response:", response.data);

    const product = response.data.product;

    // Extract weight from the first variant (assuming single variant per product)
    const weight = product.variants?.[0]?.weight || 1; // Default 0 if not found

    // console.log("variants", product.variants);

    return { length: 10, width: 10, height: 10, weight };
  } catch (error) {
    console.error("Error fetching product details:", error);
    return { length: 10, width: 10, height: 10, weight: 0 }; // Default values
  }
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
    // billing address, which was being used below before.
    const primaryPickup = await PickupAddress.findOne({
      userId,
      isPrimary: true,
    }).lean();

    if (!primaryPickup || !primaryPickup.pickupAddress) {
      return res.status(400).json({
        success: false,
        message: "No primary pickup address configured for this account. Add one before syncing Shopify orders.",
      });
    }

    const accessToken = channel.storeAccessToken;
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
      const productDetails = order.line_items.map((item) => ({
        id: item.id,
        quantity: item.quantity,
        name: item.name,
        sku: item.sku,
        unitPrice: item.price,
      }));

      // Default package dimensions
      let totalWeight = 0;
      let totalLength = 10,
        totalWidth = 10,
        totalHeight = 10;

      for (const item of order.line_items) {
        try {
          const productInfo = await getProductDetails(
            item.product_id,
            storeURL,
            accessToken
          );

          totalWeight += productInfo.weight || 0;
          totalLength = Math.max(totalLength, productInfo.length || 0);
          totalWidth = Math.max(totalWidth, productInfo.width || 0);
          totalHeight = Math.max(totalHeight, productInfo.height || 0);
        } catch (err) {
          console.warn(
            `Failed to fetch details for product ${item.product_id}`
          );
        }
      }

      // Generate a unique internal orderId (do not use Shopify's order_number to avoid duplicates)
      const internalOrderId = await generateUniqueOrderIds(1);

      const newOrder = new Order({
        userId: channel.userId,
        orderId: internalOrderId,
        channelId: order.id,
        compositeOrderId,
        channel: "Shopify",
        storeUrl: storeURL,
        pickupAddress: {
          contactName: primaryPickup.pickupAddress.contactName,
          email: primaryPickup.pickupAddress.email,
          phoneNumber: primaryPickup.pickupAddress.phoneNumber,
          address: primaryPickup.pickupAddress.address,
          pinCode: primaryPickup.pickupAddress.pinCode,
          city: primaryPickup.pickupAddress.city,
          state: primaryPickup.pickupAddress.state,
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

    const user = await AllChannel.findOne({ storeURL: storeURL });
    if (!user) {
      console.error("Store not found in AllChannel");
      return res.status(404).json({ error: "Store not found" });
    }

    if (!verifyShopifyHmac(req, user.storeClientSecret)) {
      console.warn(`❌ Shopify webhook signature mismatch for store ${storeURL}`);
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    // Fetch the seller's own warehouse/pickup address — NOT the customer's
    // billing address, which was being used here before.
    const primaryPickup = await PickupAddress.findOne({
      userId: user.userId,
      isPrimary: true,
    }).lean();

    if (!primaryPickup || !primaryPickup.pickupAddress) {
      console.warn(`⚠️ No primary pickup address configured for user ${user.userId} — skipping Shopify order sync for store ${storeURL}.`);
      return res.status(200).json({
        message: "Order not synced: no primary pickup address configured for this account.",
      });
    }

    const shopifyOrder = req.body;
    const compositeOrderId = `${storeURL}-${shopifyOrder.id}`;
    const firstLineItemId = shopifyOrder.line_items?.[0]?.id;

    // Check for existing order using compositeOrderId
    const existingOrder = await Order.findOne({ compositeOrderId });
    if (existingOrder) {
      console.log(`Order ${compositeOrderId} already exists, skipping...`);
      return res.status(200).json({ message: "Duplicate order ignored" });
    }

    // Extract product details
    const productDetails = shopifyOrder.line_items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      name: item.name,
      sku: item.sku,
      unitPrice: item.price,
    }));

    // Fetch package weight & dimensions
    let totalWeight = 0;
    let totalLength = 10,
      totalWidth = 10,
      totalHeight = 10;

    for (const item of shopifyOrder.line_items) {
      const productInfo = await getProductDetails(
        item.product_id,
        storeURL,
        user.storeAccessToken
      );

      totalWeight += productInfo.weight;
      totalLength = Math.max(totalLength, productInfo.length);
      totalWidth = Math.max(totalWidth, productInfo.width);
      totalHeight = Math.max(totalHeight, productInfo.height);
    }

    // Generate a unique internal orderId (do not use Shopify's order_number to avoid duplicates)
    const internalOrderId = await generateUniqueOrderIds(1);

    const newOrder = new Order({
      userId: user.userId,
      orderId: internalOrderId,
      compositeOrderId, // Ensure uniqueness
      channelId: firstLineItemId,
      channel: "Shopify",
      storeUrl: storeURL,
      pickupAddress: {
        contactName: primaryPickup.pickupAddress.contactName,
        email: primaryPickup.pickupAddress.email,
        phoneNumber: primaryPickup.pickupAddress.phoneNumber,
        address: primaryPickup.pickupAddress.address,
        pinCode: primaryPickup.pickupAddress.pinCode,
        city: primaryPickup.pickupAddress.city,
        state: primaryPickup.pickupAddress.state,
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
            : shopifyOrder.total_price,
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
    console.error("Error syncing Shopify order:", error);
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
      storeURL,
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

    // ✅ Register Webhook
    let webHook;
    let webhookId;
    if (channel === "Shopify") {
      webHook = await createWebhook(storeURL, storeAccessToken);
      console.log("✅ Webhook created successfully:", webHook);
      if (webHook.error === "socket hang up") {
        return res.status(400).json({
          message: "URL or Token or Secret key or Client ID are not matching",
        });
      }
      webhookId = webHook?.webhook?.id || "";
    }
    if (channel === "WooCommerce") {
      webHook = await createWooCommerceWebhook(
        storeURL,
        storeClientId,
        storeClientSecret
      );
      webhookId = webHook?.id || webHook?.webhook?.id || "";
    }
    console.log("wekdfn", webHook);
    const newChannel = new AllChannel({
      userId,
      channel,
      storeName,
      storeURL,
      storeClientId,
      storeClientSecret,
      storeAccessToken,
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
    console.error("❌ Error storing channel details:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error." });
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
    const accessToken = channel.storeAccessToken;

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
    const isCOD =
      orderDetails.payment_gateway_names.includes("cash_on_delivery");

    // If the order is not COD and payment is still pending, do not fulfill
    if (!isCOD && orderDetails.financial_status === "pending") {
      console.log("not fulfilled");
      return res.status(400).json({
        message: "Order cannot be fulfilled as payment is still pending.",
      });
    }

    // Fetch store locations
    let locationId;
    try {
      const shopData = await axios.get(
        `https://${shopifyStore}/admin/api/2024-04/locations.json`,
        {
          headers: { "X-Shopify-Access-Token": accessToken },
        }
      );
      locationId = shopData.data.locations?.[0]?.id;
      console.log("location", locationId);
    } catch (error) {
      console.error("Error fetching locations:", error.response?.data || error);
      return res
        .status(500)
        .json({ message: "Error fetching locations from Shopify" });
    }

    if (!locationId) {
      return res
        .status(400)
        .json({ message: "No location ID found for the store" });
    }

    // Fulfill the order
    try {
      const fulfillmentResponse = await axios.post(
        `https://${shopifyStore}/admin/api/2024-04/orders/${id}/fulfillments.json`,
        {
          fulfillment: {
            notify_customer: true, // Notify customer via email
            location_id: locationId,
            tracking_info: {
              number: awb_number,
              company: provider,
              url: `https://www.shiproxx.com/track/${awb_number}`, // Adjust based on courier tracking link
            },
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
      console.error("Error fulfilling order:", error.response?.data || error);
      return res.status(500).json({
        message: "Error fulfilling order on Shopify",
        error: error.response?.data,
      });
    }
  } catch (error) {
    console.error("Unexpected error in fulfillOrder:", error);
    return res.status(500).json({ message: "Internal server error", error });
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
    console.error("Error fetching channels:", error);
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
    console.error("Error fetching channel:", error);
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

    // Update the channel details
    const updatedChannel = await AllChannel.findByIdAndUpdate(
      id,
      { $set: updatedData }, // Ensure syncDate is properly formatted
      { new: true } // Return the updated document
    );

    res.status(200).json({
      message: "Channel updated successfully",
      channel: updatedChannel,
    });
  } catch (error) {
    console.error("Error updating channel:", error);
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
    console.error("Error deleting channel:", error);
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
};
