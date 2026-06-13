const axios = require("axios");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const {
  getAuthToken,
} = require("../../AllCouriers/Zipypost/Authorize/zipyPost.controller");
const {
  createWarehouse,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");
const {
  checkZipypostServiceability,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");
const mongoose = require("mongoose");
const warehouseCache = new Map();
const estimatedDeliveryDate = require("../../models/EDDMap.model");
const {
  getCachedZone,
} = require("../../AllCouriers/Zipypost/Couriers/couriers.controller");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const createZipypostShipment = async ({
  id,
  provider,
  finalCharges,
  courierServiceName,
  priceBreakup,
  userId,
  walletId,
  walletBalance,
  walletHoldAmount,
  walletCreditLimit,
}) => {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // ✅ Step 1: Fetch order safely
      const currentOrder = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true, session }
      );

      if (!currentOrder) {
        await session.abortTransaction();
        session.endSession();
        return {
          success: false,
          message:
            "Shipment already created or order is being processed by another request.",
        };
      }

      // ✅ Step 2: Skip redundant user/wallet queries - parameters pre-fetched

      // ✅ Step 3: Check wallet balance
      const hold = walletHoldAmount || 0;
      const effectiveBalance = walletBalance - hold;
      const balance = effectiveBalance + walletCreditLimit;
      if (balance < finalCharges) throw new Error("Insufficient wallet balance");

      // ✅ Step 4: Get zone (cached for speed)
      const zone = await getCachedZone(
        currentOrder.pickupAddress.pinCode,
        currentOrder.receiverAddress.pinCode
      );
      if (!zone) throw new Error("Pincode not serviceable");

      // ✅ Estimate Delivery Date (from DB)
      const eddData = await estimatedDeliveryDate.findOne({
        courier: "ZipyPost",
        serviceName: courierServiceName.trim(),
      });

      let estimateDate = null;
      if (eddData) {
        let deliveryDays = null;
        if (
          eddData.zoneRates &&
          typeof eddData.zoneRates[zone.zone] === "number"
        ) {
          deliveryDays = eddData.zoneRates[zone.zone];
        } else if (typeof eddData[zone.zone] === "number") {
          deliveryDays = eddData[zone.zone];
        }

        if (deliveryDays) {
          estimateDate = new Date();
          estimateDate.setDate(estimateDate.getDate() + deliveryDays);
        }
      }

      // ✅ Step 5: Auth and serviceability
      const sellerId = process.env.ZIPYPOST_SELLER_ID;
      const token = await getAuthToken();

      const payload = {
        source_pincode: currentOrder.pickupAddress.pinCode,
        destination_pincode: currentOrder.receiverAddress.pinCode,
        payment_type: currentOrder.paymentDetails?.method,
        order_weight: currentOrder.packageDetails.applicableWeight,
        length: currentOrder.packageDetails.volumetricWeight?.length || 0,
        breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
        height: currentOrder.packageDetails.volumetricWeight?.height || 0,
        order_value: currentOrder.paymentDetails?.amount || 0,
      };

      const serviceability = await checkZipypostServiceability(payload);
      if (!serviceability?.data?.length)
        throw new Error("No serviceable courier available");

      const validCouriers = serviceability.data.filter(
        (svc) => svc.courier_id === 9 || svc.courier_id === 10
      );

      let courier_id = 0;
      if (courierServiceName.toLowerCase().includes("xpressbees")) courier_id = 9;
      else if (courierServiceName.toLowerCase().includes("bluedart"))
        courier_id = 10;

      if (!courier_id) throw new Error("Only Xpressbees and Bluedart supported.");

      const courierOptions = validCouriers.filter(
        (svc) => svc.courier_id === courier_id
      );

      const applicableWeight = currentOrder.packageDetails.applicableWeight;
      const selectedMode =
        courierOptions.find(
          (option) => applicableWeight <= parseFloat(option.slab)
        ) || courierOptions[courierOptions.length - 1];

      if (!selectedMode) throw new Error("Unable to determine courier mode_id");
      const mode_id = selectedMode.mode_id;

      // ✅ Step 6: Cached warehouse creation
      const whKey = `${currentOrder.userId}-${currentOrder.pickupAddress.pinCode}`;
      let warehouseId = warehouseCache.get(whKey);

      if (!warehouseId) {
        const baseName = (
          currentOrder.pickupAddress.contactName || "Warehouse"
        ).substring(0, 10);
        const shortUserId = currentOrder.userId.toString().substring(0, 6);
        const finalWarehouseName =
          `${baseName}-${shortUserId}-${currentOrder.pickupAddress.pinCode}`.substring(
            0,
            30
          );

        const warehouseData = {
          warehouseName: finalWarehouseName,
          contactName: currentOrder.pickupAddress.contactName,
          contactNumber: currentOrder.pickupAddress.phoneNumber?.replace(
            /^0+/,
            ""
          ),
          AddressLineOne:
            currentOrder.pickupAddress.address?.substring(0, 45) || "",
          AddressLineTwo:
            currentOrder.pickupAddress.address?.substring(0, 45) || "",
          pincode: currentOrder.pickupAddress.pinCode,
          city: currentOrder.pickupAddress.city,
          primary: true,
        };

        const whResult = await createWarehouse(
          currentOrder.userId,
          warehouseData,
          token.authToken,
          token.timestamp,
          sellerId
        );

        if (!whResult.success) {
          await session.abortTransaction();
          session.endSession();
          return {
            success: false,
            message:
              "Pickup address is not registered. Please register it using the Warehouse API.",
          };
        }

        warehouseCache.set(whKey, whResult.warehouseId);
        warehouseId = whResult.warehouseId;
      }

      // ✅ Step 7: Prepare shipment creation payload
      const totalProducts = currentOrder.productDetails.length;

      const requestBody = {
        order_number: currentOrder.orderId,
        purchase_amount: currentOrder.paymentDetails.amount,
        purchase_date: currentOrder.createdAt.toISOString().split("T")[0],
        billing_details_same_as_shipping: true,
        shipping_details: {
          full_name: currentOrder.receiverAddress.contactName,
          contact_number: currentOrder.receiverAddress.phoneNumber?.replace(
            /^0+/,
            ""
          ),
          customer_email:
            currentOrder.receiverAddress.email || "example@email.com",
          address_line_one: currentOrder.receiverAddress.address?.slice(0, 104),
          address_line_two: currentOrder.receiverAddress.address?.slice(0, 104),
          pincode: currentOrder.receiverAddress.pinCode,
          city: currentOrder.receiverAddress.city,
        },
        billing_details: {
          full_name: currentOrder.pickupAddress.contactName,
          contact_number: currentOrder.pickupAddress.phoneNumber?.replace(
            /^0+/,
            ""
          ),
          address_line_one:
            currentOrder.pickupAddress.address?.substring(0, 45) || "",
          address_line_two:
            currentOrder.pickupAddress.address?.substring(45, 90) || "",
          pincode: currentOrder.pickupAddress.pinCode,
          city: currentOrder.pickupAddress.city,
        },
        items: currentOrder.productDetails.map((p) => ({
          sku: p.sku?.length >= 3 ? p.sku : `SKU${currentOrder.orderId}`,
          item_name: p.name,
          quantity: p.quantity || 1,
          item_weight:
            currentOrder.packageDetails.applicableWeight / totalProducts,
          item_price: p.unitPrice,
        })),
        package_length: currentOrder.packageDetails.length || 10,
        package_width: currentOrder.packageDetails.width || 10,
        package_height: currentOrder.packageDetails.height || 10,
        package_weight: currentOrder.packageDetails.applicableWeight || 0.5,
        warehouse_id: warehouseId,
        payment_type: currentOrder.paymentDetails.method === "COD" ? 2 : 1,
        courier_id,
        mode_id,
      };

      // ✅ Step 8: Create shipment via API
      const response = await axios.post(
        "https://api.zipypost.com/create/shipment",
        requestBody,
        {
          headers: {
            "Content-Type": "application/json",
            authorization: token.authToken,
            timestamp: token.timestamp,
            sellerid: sellerId,
          },
          timeout: 15000,
        }
      );

      if (!response.data.success || !response.data.booking) {
        throw new Error(response.data.message || "Failed to create shipment");
      }

      const result = response.data.RESULT;

      // ✅ Step 9: Update DB atomically
      currentOrder.status = "Booked";
      currentOrder.awb_number = result.awb;
      currentOrder.shipment_id = currentOrder.orderId;
      currentOrder.provider = result.courier?.replace(/\+/g, "").trim();
      currentOrder.partner = "ZipyPost";
      currentOrder.shipmentCreatedAt = new Date();
      currentOrder.totalFreightCharges = finalCharges || 0;
      currentOrder.courierServiceName = courierServiceName;
      currentOrder.zone = zone.zone;
      currentOrder.priceBreakup = priceBreakup;

      // 🔹 Take estimatedDeliveryDate from DB
      currentOrder.estimatedDeliveryDate = estimateDate || "";

      currentOrder.tracking.push({
        status: "Booked",
        StatusLocation: currentOrder.pickupAddress.city,
        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
        Instructions: "Order booked successfully",
      });

      await Promise.all([
        currentOrder.save({ session }),
        Wallet.updateOne(
          { _id: walletId },
          {
            $inc: { balance: -finalCharges },
          },
          { session }
        ),
        WalletTransaction.create(
          [
            {
              walletId: walletId,
              channelOrderId: currentOrder.orderId,
              category: "debit",
              amount: finalCharges,
              balanceAfterTransaction: walletBalance - finalCharges,
              date: new Date(),
              awb_number: result.awb,
              description: "Freight Charges Applied",
              priceBreakup
            }
          ],
          { session }
        )
      ]);

      await session.commitTransaction();
      session.endSession();

      // ── Auto-assign pickup manifest (non-blocking) ──
      Order.findById(currentOrder._id)
        .then((freshOrder) => {
          if (freshOrder) assignPickupManifest(freshOrder);
        })
        .catch((pErr) => {
          console.error("[Pickup] assignPickupManifest failed:", pErr.message);
        });

      return {
        success: true,
        message: "Shipment Created Successfully",
        awb_number: result.awb,
      };
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      session.endSession();

      // Check if transient error (Write Conflict)
      const isTransient =
        error.errorLabels?.includes("TransientTransactionError") ||
        error.code === 112 ||
        error.message?.includes("WriteConflict");

      if (isTransient && attempt < maxRetries) {
        console.warn(`[API ZipyPost createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }

      console.error(
        "Error creating Zipypost shipment:",
        error?.response?.data || error.message
      );
      return {
        success: false,
        message:
          error?.response?.data?.error?.booking_process_error ||
          error?.response?.data?.message ||
          error.message ||
          "Failed to create shipment",
      };
    }
  }
};

module.exports = createZipypostShipment;
