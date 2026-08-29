const axios = require("axios");
const mongoose = require("mongoose");
const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const PickupAddress = require("../../../models/pickupAddress.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const BOXDLOGISTICS_TOKEN = process.env.BOXDLOGISTICS_TOKEN;
const BASE_URL = "https://api.boxdlogistics.com/seller/v1";

// BoxdLogistics error responses use `detail` (e.g. { detail: "Wallet balance
// is low for seller 484" }), not `message` — pulling `.message` alone left
// the caller with only the generic fallback text, hiding the real reason.
const extractBoxdErrorMessage = (err, fallback) =>
    err.response?.data?.detail || err.response?.data?.message || err.message || fallback;

// ─── Helper: Cache and Warehouse Creation ───────────────────────────────────
const boxdWarehouseCache = new Map();

const createBoxdWarehouse = async (userId, pickup) => {
    try {
        const cacheKey = `${userId}_${pickup.pinCode}`;
        if (boxdWarehouseCache.has(cacheKey)) {
            return boxdWarehouseCache.get(cacheKey);
        }

        let actualPickupRecord = await PickupAddress.findOne({
            userId,
            "pickupAddress.pinCode": String(pickup.pinCode),
            "pickupAddress.contactName": pickup.contactName
        });

        if (!actualPickupRecord) {
            actualPickupRecord = new PickupAddress({
                userId,
                pickupAddress: {
                    contactName: pickup.contactName,
                    email: pickup.email || "info@shiproxx.com",
                    phoneNumber: pickup.phoneNumber,
                    address: pickup.address,
                    pinCode: pickup.pinCode,
                    city: pickup.city,
                    state: pickup.state,
                }
            });
            await actualPickupRecord.save();
        }

        if (actualPickupRecord.boxdLogisticsWarehouseId) {
            boxdWarehouseCache.set(cacheKey, actualPickupRecord.boxdLogisticsWarehouseId);
            return actualPickupRecord.boxdLogisticsWarehouseId;
        }

        const payload = {
            full_name: actualPickupRecord.pickupAddress.contactName,
            warehouse_name: `${actualPickupRecord.pickupAddress.contactName.replace(/\s+/g, '_').toLowerCase()}_${actualPickupRecord.pickupAddress.pinCode}`,
            address_line1: actualPickupRecord.pickupAddress.address.substring(0, 100),
            state: actualPickupRecord.pickupAddress.state,
            city: actualPickupRecord.pickupAddress.city,
            landmark: "",
            pincode: String(actualPickupRecord.pickupAddress.pinCode),
            country: "India",
            support_phone_number: "",
            phone_number: parseInt(actualPickupRecord.pickupAddress.phoneNumber.replace(/\D/g, '')) || 8569065690,
            return_full_name: actualPickupRecord.pickupAddress.contactName,
            return_warehouse_name: null,
            return_email: null,
            return_phone_number: null,
            return_isd_code: "+91",
            same_as_rto_address: true,
        };

        const response = await axios.post(`${BASE_URL}/warehouse/create/`, payload, {
            headers: {
                Authorization: `Token ${BOXDLOGISTICS_TOKEN}`,
                "Content-Type": "application/json",
            },
        });

        if (response.data?.id || response.data?.warehouse_id) {
            const whId = String(response.data.id || response.data.warehouse_id);
            actualPickupRecord.boxdLogisticsWarehouseId = whId;
            await actualPickupRecord.save();
            boxdWarehouseCache.set(cacheKey, whId);
            return whId;
        }
        return null;
    } catch (error) {
        console.error("BoxdLogistics warehouse creation error:", error.response?.data || error.message);
        return null;
    }
};
const createBoxdOrder = async (currentOrder, courierServiceName, preResolvedWarehouseId) => {
    const isCOD = currentOrder.paymentDetails?.method === "COD";
    const codAmount = isCOD ? (currentOrder.paymentDetails?.amount || 0) : 0;

    const products = currentOrder.productDetails.map((p) => ({
        sku: p.sku && p.sku.length >= 3 ? p.sku : `SKU${currentOrder.orderId}`,
        name: p.name,
        description: p.description || null,
        category: null,
        quantity: p.quantity || 1,
        unit_price: p.unitPrice || 0,
        discount_amount: 0,
        is_tax_inclusive: false,
        tax_rate: "18.00",
        hsn_code: p.hsn || null,
        length_in_cm: String(currentOrder.packageDetails.volumetricWeight?.length || 10),
        breadth_in_cm: String(currentOrder.packageDetails.volumetricWeight?.width || 10),
        height_in_cm: String(currentOrder.packageDetails.volumetricWeight?.height || 10),
        weight_in_gm: String(
            ((currentOrder.packageDetails.applicableWeight || 0.5) /
                currentOrder.productDetails.length) *
            1000
        ),
        vol_weight_in_gm: null,
    }));

    const payload = {
        order_number: currentOrder.orderId,
        order_invoice_number: null,
        customer_name: currentOrder.receiverAddress.contactName?.trim() || "",
        customer_email: currentOrder.receiverAddress.email || null,
        customer_phone_number:
            parseInt(currentOrder.receiverAddress.phoneNumber?.replace(/\D/g, "")) || null,
        customer_isd_code: "+91",
        customer_gst_number: null,
        warehouse_id: preResolvedWarehouseId ? parseInt(preResolvedWarehouseId) : (parseInt(await createBoxdWarehouse(currentOrder.userId, currentOrder.pickupAddress)) || 1),
        // Shipping (receiver)
        shipping_name: currentOrder.receiverAddress.contactName?.trim() || "",
        shipping_email: currentOrder.receiverAddress.email || null,
        shipping_phone_number:
            parseInt(currentOrder.receiverAddress.phoneNumber?.replace(/\D/g, "")) || null,
        shipping_isd_code: "+91",
        shipping_alt_phone_number: null,
        shipping_alt_isd_code: "+91",
        shipping_address_type: "home",
        shipping_address_line1: currentOrder.receiverAddress.address?.substring(0, 100) || "",
        shipping_address_line2: null,
        shipping_landmark: null,
        shipping_pincode: String(currentOrder.receiverAddress.pinCode),
        shipping_city: currentOrder.receiverAddress.city || "",
        shipping_state: currentOrder.receiverAddress.state || "",
        shipping_country: "India",
        shipping_latitude: null,
        shipping_longitude: null,
        // Billing (pickup/sender)
        billing_name: currentOrder.pickupAddress.contactName?.trim() || "",
        billing_email: null,
        billing_phone_number:
            parseInt(currentOrder.pickupAddress.phoneNumber?.replace(/\D/g, "")) || null,
        billing_isd_code: "+91",
        billing_alt_phone_number: null,
        billing_alt_isd_code: "+91",
        billing_address_type: "office",
        billing_address_line1: currentOrder.pickupAddress.address?.substring(0, 100) || "",
        billing_address_line2: null,
        billing_landmark: null,
        billing_pincode: String(currentOrder.pickupAddress.pinCode),
        billing_city: currentOrder.pickupAddress.city || "",
        billing_state: currentOrder.pickupAddress.state || "",
        billing_country: "India",
        billing_latitude: null,
        billing_longitude: null,
        // Package
        package_length_in_cm: String(currentOrder.packageDetails.volumetricWeight?.length || 10),
        package_breadth_in_cm: String(currentOrder.packageDetails.volumetricWeight?.width || 10),
        package_height_in_cm: String(currentOrder.packageDetails.volumetricWeight?.height || 10),
        package_weight_in_gm: String((currentOrder.packageDetails.applicableWeight || 0.5) * 1000),
        // Financial
        cgst_amount: null,
        sgst_amount: null,
        igst_amount: null,
        cess_amount: null,
        cgst_tax_rate: null,
        sgst_tax_rate: null,
        igst_tax_rate: null,
        cess_tax_rate: null,
        is_tax_inclusive: false,
        tax_rate: null,
        tax_amount: null,
        shipping_charges: null,
        discount_amount: 0,
        subtotal_amount: currentOrder.paymentDetails?.amount || 0,
        total_amount: String(currentOrder.paymentDetails?.amount || 0),
        payment_mode: isCOD ? "cod" : "prepaid",
        tags: null,
        notes: null,
        is_cod: isCOD,
        cod_collectable_amount: isCOD ? String(codAmount) : "0.00",
        is_mps: false,
        is_reverse: false,
        order_date: currentOrder.createdAt
            ? new Date(currentOrder.createdAt).toISOString()
            : new Date().toISOString(),
        products,
    };

    const response = await axios.post(`${BASE_URL}/order/create/`, payload, {
        headers: {
            Authorization: `Token ${BOXDLOGISTICS_TOKEN}`,
            "Content-Type": "application/json",
        },
    });
    console.log("order creation response", response.data)
    return response.data;
};

// ─── Helper: ship (assign courier) ───────────────────────────────────────────
const shipBoxdOrder = async (boxdOrderId, courierId) => {
    console.log("Booking payload", { order_id: boxdOrderId, courier_id: courierId });
    const response = await axios.post(
        `${BASE_URL}/order/ship/`,
        { order_id: boxdOrderId, courier_id: courierId },
        {
            headers: {
                Authorization: `Token ${BOXDLOGISTICS_TOKEN}`,
                "Content-Type": "application/json",
            },
        }
    );
    console.log("ship order response",response.data)
    return response.data;
};

// ─── Helper: serviceability / rate calculator ─────────────────────────────────
const checkServiceabilityBoxdLogistics = async ({
    pickupPincode,
    shippingPincode,
    paymentMode,
    codAmount,
    length,
    breadth,
    height,
    weight,
}) => {
    try {
        if (!pickupPincode || !shippingPincode || !paymentMode || !weight) {
            return { success: false, message: "Required parameters are missing" };
        }

        const response = await axios.get(`${BASE_URL}/rate-calculator/`, {
            headers: { Authorization: `Token ${BOXDLOGISTICS_TOKEN}` },
            params: {
                payment_mode: paymentMode,
                pickup_pincode: pickupPincode,
                shipping_pincode: shippingPincode,
                cod_collectable_amount: codAmount,
                package_length_in_cm: length,
                package_breadth_in_cm: breadth,
                package_height_in_cm: height,
                package_weight_in_gm: weight,
            },
        });

        const couriers = response.data || [];
        // console.log("couriers", couriers)
        const matchedCouriers = couriers
            .filter((c) => c.courier_id === 4 || c.courier_id === 6 || c.courier_id === 7 || c.courier_id === 47)
            .map((c) => c.courier_id);

        if (matchedCouriers.length > 0) {
            // console.log("matchedCouriers", matchedCouriers)
            return {
                success: true,
                courier_ids: matchedCouriers,
            };
        }

        return {
            success: false,
            message: "Courier 4, 6, 7 or 47 not available",
        };
    } catch (error) {
        console.log("error", error.response?.data || error.message)
        return {
            success: false,
            message: "Failed to fetch rate",
            error: error.response?.data || error.message,
        };
    }
};

// ─── Main: Create BoxdLogistics Shipment (single order via HTTP) ──────────────
const createBoxdLogisticsOrder = async (req, res) => {
    const session = await mongoose.startSession();

    try {
        const {
            id,
            provider,
            finalCharges,
            courierServiceName,
            courier,         // courier_id from serviceability data
            estimatedDeliveryDate,
            priceBreakup,
        } = req.body;

        session.startTransaction();

        // Atomically lock the order
        const currentOrder = await Order.findOneAndUpdate(
            { _id: id, status: "new" },
            { $set: { status: "processing" } },
            { new: true, session }
        );

        if (!currentOrder) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: "Shipment already created or order is being processed.",
            });
        }

        // Parallel: zone + user
        const [zone, user] = await Promise.all([
            getZone(currentOrder.pickupAddress.pinCode, currentOrder.receiverAddress.pinCode),
            User.findById(currentOrder.userId).session(session),
        ]);

        let actualPickupRecord = await PickupAddress.findOne({
            userId: currentOrder.userId,
            "pickupAddress.pinCode": String(currentOrder.pickupAddress.pinCode),
            "pickupAddress.contactName": currentOrder.pickupAddress.contactName
        });

        if (!actualPickupRecord) {
            actualPickupRecord = new PickupAddress({
                userId: currentOrder.userId,
                pickupAddress: {
                    contactName: currentOrder.pickupAddress.contactName,
                    email: currentOrder.pickupAddress.email || user?.email || "info@shiproxx.com",
                    phoneNumber: currentOrder.pickupAddress.phoneNumber,
                    address: currentOrder.pickupAddress.address,
                    pinCode: currentOrder.pickupAddress.pinCode,
                    city: currentOrder.pickupAddress.city,
                    state: currentOrder.pickupAddress.state,
                }
            });
            await actualPickupRecord.save();
        }

        if (!zone) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: "Pincode not serviceable" });
        }

        if (!user) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const currentWallet = await Wallet.findById(user.Wallet).select("balance holdAmount creditLimit").session(session);
        if (!currentWallet) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ success: false, message: "Wallet not found" });
        }

        // Wallet check
        const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0);
        const balance = effectiveBalance + (currentWallet.creditLimit || 0);
        if (balance < finalCharges) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ success: false, message: "Insufficient Wallet Balance" });
        }

        // Step 1: Create order on BoxdLogistics
        let createRes;
        try {
            createRes = await createBoxdOrder(currentOrder, courierServiceName);
            console.log("BoxdLogistics create order response:", createRes);
        } catch (err) {
            await session.abortTransaction();
            session.endSession();
            console.error("❌ BoxdLogistics create order failed:", err.response?.data || err.message);
            return res.status(500).json({
                success: false,
                message: extractBoxdErrorMessage(err, "Failed to create order"),
                error: err.response?.data || err.message,
            });
        }

        // BoxdLogistics returns { id: <order_id>, ... } or similar — extract the portal order ID
        const boxdOrderId = createRes?.id || createRes?.order_id;
        if (!boxdOrderId) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: createRes?.message || "BoxdLogistics did not return a valid order ID",
            });
        }

        // Step 2: Ship (assign courier) — courier_id comes from serviceability
        let shipRes;
        try {
            const courierId = parseInt(courier) || 3; // courier passed from frontend, fallback 3
            shipRes = await shipBoxdOrder(boxdOrderId, courierId);
            console.log("BoxdLogistics ship response:", shipRes);
        } catch (err) {
            await session.abortTransaction();
            session.endSession();
            console.error("❌ BoxdLogistics ship order failed:", err.response?.data || err.message);
            return res.status(500).json({
                success: false,
                message: extractBoxdErrorMessage(err, "Failed to ship order"),
                error: err.response?.data || err.message,
            });
        }

        // Extract AWB from ship response
        const awb = shipRes?.awb_number || shipRes?.tracking_number || shipRes?.shipment?.awb || "";
        if (!awb) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                success: false,
                message: shipRes?.message || "BoxdLogistics did not return a valid AWB number",
            });
        }

        const balanceToDeduct = parseFloat(finalCharges) || 0;

        // Update order inside transaction
        await Order.findByIdAndUpdate(
            id,
            {
                $set: {
                    status: "Booked",
                    cancelledAtStage: null,
                    awb_number: awb,
                    shipment_id: String(boxdOrderId),
                    provider: "Bluedart",
                    partner: "BoxdLogistics",
                    totalFreightCharges: balanceToDeduct,
                    courierServiceName,
                    shipmentCreatedAt: new Date(),
                    zone: zone.zone,
                    estimatedDeliveryDate: estimatedDeliveryDate || "",
                    priceBreakup,
                },
                $push: {
                    tracking: {
                        status: "Booked",
                        StatusLocation: currentOrder.pickupAddress?.city || "N/A",
                        StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
                        Instructions: "Order booked successfully",
                    },
                },
            },
            { session, new: true }
        );

        await session.commitTransaction();
        session.endSession();

        // ── Auto-assign pickup manifest ──
        try {
            const freshOrder = await Order.findById(id);
            if (freshOrder) await assignPickupManifest(freshOrder);
        } catch (pErr) {
            console.error("[Pickup] assignPickupManifest failed:", pErr.message);
        }

        // Send response immediately
        res.status(200).json({
            success: true,
            message: "Shipment Created Successfully",
            awb_number: awb,
            orderId: currentOrder.orderId,
        });

        // Deduct wallet balance in background
        process.nextTick(async () => {
            try {
                await Wallet.findOneAndUpdate(
                    { _id: user.Wallet },
                    {
                        $inc: { balance: -balanceToDeduct },
                    }
                );
                // 🔁 Dual-write: mirror to WalletTransaction for future migration
                await WalletTransaction.create({
                    walletId: user.Wallet,
                    channelOrderId: currentOrder.orderId || null,
                    category: "debit",
                    amount: balanceToDeduct,
                    balanceAfterTransaction: currentWallet.balance - balanceToDeduct,
                    date: new Date(),
                    awb_number: awb,
                    description: "Freight Charges Applied",
                    priceBreakup
                });
            } catch (err) {
                console.error("BoxdLogistics wallet update error:", err.message);
            }
        });
    } catch (error) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        session.endSession();
        console.error("❌ BoxdLogistics shipment error:", error.response?.data || error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to create shipment",
            error: error.response?.data || error.message,
        });
    }
};

// ─── Cancel Order ─────────────────────────────────────────────────────────────
const cancelOrderBoxdLogistics = async (awb_number, orderId) => {
    try {
        if (!awb_number || !orderId) return { success: false, message: "AWB number and order ID are required" };

        const isCancelled = await Order.findOne({ awb_number: awb_number, status: "Cancelled" });
        if (isCancelled) return { success: false, error: "Order is already cancelled", code: 400 };

        // BoxdLogistics cancel by AWB
        const response = await axios.post(
            `${BASE_URL}/order/cancel-shipment/`,
            { awb_number: awb_number, order_id: orderId },
            { headers: { Authorization: `Token ${BOXDLOGISTICS_TOKEN}`, "Content-Type": "application/json" } }
        );

        console.log("BoxdLogistics Cancel Response:", response.data);
        if (response.data?.success || response.status === 200) {
            // await Order.findOneAndUpdate(
            //     { orderId: orderId },
            //     { status: "Cancelled", cancelledAtStage: "Cancelled" }
            // );
            return { data: response.data, code: 201 };
        }
        return { error: "Error in shipment cancellation", details: response.data, code: 400, success: false };
    } catch (error) {
        console.error("Error cancelling BoxdLogistics shipment:", error.response?.data || error.message);
        return { success: false, message: "Failed to cancel shipment", error: error.response?.data || error.message };
    }
};

// ─── Track Order ──────────────────────────────────────────────────────────────
const trackOrderBoxdLogistics = async (AWBNo) => {
    try {
        const response = await axios.get(`${BASE_URL}/order/tracking/`, {
            headers: { Authorization: `Token ${BOXDLOGISTICS_TOKEN}` },
            params: { awb_number: AWBNo },
        });

        // API returns array of shipment objects; tracking_history is on the first item
        const shipmentData = Array.isArray(response.data) ? response.data[0] : response.data;
        const trackingHistory = shipmentData?.tracking_history || [];

        // Sort newest first (reverse chronological) so result.data[0] = latest
        const sorted = [...trackingHistory].sort(
            (a, b) => new Date(b.datetime || b.created_at) - new Date(a.datetime || a.created_at)
        );

        // console.log("BoxdLogistics tracking data:", sorted);
        return { success: true, data: sorted.reverse() };
    } catch (error) {
        console.error("BoxdLogistics tracking error:", error.response?.data || error.message);
        return { success: false, error: error.response?.data || error.message, status: 500 };
    }
};

// trackOrderBoxdLogistics("76890137936");

module.exports = {
    checkServiceabilityBoxdLogistics,
    createBoxdLogisticsOrder,
    cancelOrderBoxdLogistics,
    trackOrderBoxdLogistics,
    createBoxdOrder,
    shipBoxdOrder,
    createBoxdWarehouse,
};