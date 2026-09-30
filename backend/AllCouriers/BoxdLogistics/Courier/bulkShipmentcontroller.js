const Order = require("../../../models/newOrder.model");
const User = require("../../../models/User.model");
const Wallet = require("../../../models/wallet");
const WalletTransaction = require("../../../models/WalletTransaction.model");
const { getZone } = require("../../../Rate/zoneManagementController");
const { createBoxdOrder, shipBoxdOrder } = require("./couriers.controller");
const { assignPickupManifest } = require("../../../Orders/scheduledPickup.controller");

const createOrderBoxdLogistics = async (
    serviceDetails,
    orderId,
    wh,
    walletId,
    charges,
    priceBreakup
) => {
    try {
        console.log("➡️ Creating BoxdLogistics order:", orderId);

        const currentOrder = await Order.findById(orderId);
        if (!currentOrder) return { success: false, message: "Order not found" };

        const { createBoxdWarehouse } = require("./couriers.controller");

        // Parallelize DB fetches, zone checks, and warehouse creation
        const [user, currentWallet, zone, warehouseId] = await Promise.all([
            User.findById(currentOrder.userId),
            Wallet.findById(walletId).select("balance holdAmount creditLimit"),
            getZone(
                currentOrder.pickupAddress.pinCode,
                currentOrder.receiverAddress.pinCode
            ),
            createBoxdWarehouse(currentOrder.userId, currentOrder.pickupAddress)
        ]);

        if (!user) return { success: false, message: "User not found" };
        if (!currentWallet) return { success: false, message: "Wallet not found" };

        // Wallet balance check
        const effectiveBalance = currentWallet.balance - (currentWallet.holdAmount || 0);
        const balance = effectiveBalance + (currentWallet.creditLimit || 0);
        if (balance < charges) return { success: false, message: "Insufficient Wallet Balance" };

        // Zone check
        if (!zone) return { success: false, message: "Pincode not serviceable" };

        // Step 1: Create order on BoxdLogistics portal
        let createRes;
        try {
            createRes = await createBoxdOrder(currentOrder, serviceDetails.name, warehouseId);
            console.log("BoxdLogistics bulk create response:", createRes);
        } catch (err) {
            console.error("❌ BoxdLogistics bulk create failed:", err.response?.data || err.message);
            return {
                success: false,
                message: err.response?.data?.message || err.message || "Failed to create order",
            };
        }

        const boxdOrderId = createRes?.id || createRes?.order_id;
        if (!boxdOrderId) {
            return {
                success: false,
                message: createRes?.message || "BoxdLogistics did not return a valid order ID",
            };
        }
        // console.log("serviceDetails",serviceDetails)
        // Step 2: Ship (assign courier_id)
        // courier_id should be stored in serviceDetails or fallback to 3
        const courierId = parseInt(serviceDetails?.courierId);
        let shipRes;
        try {
            shipRes = await shipBoxdOrder(boxdOrderId, courierId);
            console.log("BoxdLogistics bulk ship response:", shipRes);
        } catch (err) {
            console.error("❌ BoxdLogistics bulk ship failed:", err.response?.data || err.message);
            return {
                success: false,
                message: err.response?.data?.message || "Failed to ship order",
            };
        }

        const awb =
            shipRes?.awb_number || shipRes?.tracking_number || shipRes?.shipment?.awb || "";
        if (!awb) {
            return {
                success: false,
                message: shipRes?.message || "BoxdLogistics did not return a valid AWB number",
            };
        }

        const finalCharges = parseFloat(charges) || 0;

        // Update order
        currentOrder.status = "Ready To Ship";
        currentOrder.awb_number = awb;
        currentOrder.shipment_id = String(boxdOrderId);
        currentOrder.provider = "Bluedart";
        currentOrder.partner = "BoxdLogistics";
        currentOrder.shipmentCreatedAt = new Date();
        currentOrder.totalFreightCharges = finalCharges;
        currentOrder.courierServiceName = serviceDetails.name;
        currentOrder.zone = zone.zone;
        currentOrder.priceBreakup = priceBreakup;
        currentOrder.tracking.push({
            status: "Ready To Ship",
            StatusLocation: currentOrder.pickupAddress?.city || "N/A",
            StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
            Instructions: "Shipment booked successfully via BoxdLogistics",
        });

        await currentOrder.save();

        // ── Auto-assign pickup manifest (non-blocking) ──
        Order.findById(currentOrder._id)
            .then((freshOrder) => {
                if (freshOrder) assignPickupManifest(freshOrder);
            })
            .catch((pErr) => {
                console.error("[Pickup] assignPickupManifest failed:", pErr.message);
            });

        // Deduct wallet
        await Wallet.findOneAndUpdate(
            { _id: walletId },
            {
                $inc: { balance: -finalCharges },
            }
        );

        // 🔁 Dual-write: mirror to WalletTransaction for future migration
        await WalletTransaction.create({
            walletId: walletId,
            channelOrderId: currentOrder.orderId || null,
            category: "debit",
            amount: finalCharges,
            balanceAfterTransaction: currentWallet.balance - finalCharges,
            date: new Date(),
            awb_number: awb,
            description: "Freight Charges Applied",
            priceBreakup
        });

        return {
            success: true,
            message: "Shipment Created Successfully via BoxdLogistics",
            data: { awb, boxdOrderId },
        };
    } catch (error) {
        console.error("❌ BoxdLogistics bulk shipment error:", error.response?.data || error.message);
        return {
            success: false,
            message: error.response?.data?.message || error.message,
            error: error.response?.data || error.message,
        };
    }
};

module.exports = { createOrderBoxdLogistics };
