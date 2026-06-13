const mongoose = require("mongoose");
const Order = require("../../models/newOrder.model");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const {
    createBoxdOrder,
    shipBoxdOrder,
    createBoxdWarehouse,
} = require("../../AllCouriers/BoxdLogistics/Courier/couriers.controller");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const createBoxdLogisticsShipment = async ({
    id,
    provider,
    finalCharges,
    courierServiceName,
    courier,       // courier_id (number) from serviceability response
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

            // Step 1: Atomically lock the order
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
                    message: "Shipment already created or order is being processed.",
                };
            }

            // Step 2: Fetch zone and warehouse ID in parallel
            const [zone, warehouseId] = await Promise.all([
                getZone(
                    currentOrder.pickupAddress.pinCode,
                    currentOrder.receiverAddress.pinCode
                ),
                createBoxdWarehouse(currentOrder.userId, currentOrder.pickupAddress)
            ]);

            // Step 3: Wallet balance check
            const hold = walletHoldAmount || 0;
            const effectiveBalance = walletBalance - hold;
            const balance = effectiveBalance + (walletCreditLimit || 0);
            if (balance < finalCharges) throw new Error("Insufficient wallet balance");

            // Step 4: Zone check
            if (!zone) throw new Error("Pincode not serviceable");

            // Step 5: Create order on BoxdLogistics portal
            let createRes;
            try {
                createRes = await createBoxdOrder(currentOrder, courierServiceName, warehouseId);
                console.log("BoxdLogistics API create response:", createRes);
            } catch (err) {
                throw new Error(err.response?.data?.message || err.message || "Failed to create order");
            }

            const boxdOrderId = createRes?.id || createRes?.order_id;
            if (!boxdOrderId) {
                throw new Error(createRes?.message || "BoxdLogistics did not return a valid order ID");
            }

            // Step 6: Ship (assign courier)
            let shipRes;
            try {
                let courierId = parseInt(courier);
                if (!courierId) {
                    const sName = courierServiceName.toLowerCase();
                    if (sName.includes("flat 0.5kg") || sName.includes("flat 0.5")) {
                        courierId = 47;
                    } else if (sName.includes("flat 2kg")) {
                        courierId = 7;
                    } else if (sName.includes("air")) {
                        courierId = 6;
                    } else if (sName.includes("surface")) {
                        courierId = 4;
                    }
                }

                if (!courierId) {
                    throw new Error("Courier ID is required for BoxdLogistics shipment");
                }
                shipRes = await shipBoxdOrder(boxdOrderId, courierId);
                console.log("BoxdLogistics API ship response:", shipRes);
            } catch (err) {
                throw new Error(err.response?.data?.message || err.message || "Failed to ship order");
            }

            const awb =
                shipRes?.awb_number ||
                shipRes?.tracking_number ||
                shipRes?.shipment?.awb ||
                "";

            if (!awb) {
                throw new Error(shipRes?.message || "BoxdLogistics did not return a valid AWB number");
            }

            // Step 7: Update order + wallet atomically
            const balanceToBeDeducted = parseFloat(finalCharges) || 0;

            await Promise.all([
                Order.findByIdAndUpdate(
                    id,
                    {
                        $set: {
                            status: "Booked",
                            awb_number: awb,
                            shipment_id: String(boxdOrderId),
                            provider: "Bluedart",
                            partner: "BoxdLogistics",
                            shipmentCreatedAt: new Date(),
                            totalFreightCharges: balanceToBeDeducted,
                            courierServiceName,
                            zone: zone.zone,
                            priceBreakup
                        },
                        $push: {
                            tracking: {
                                status: "Booked",
                                StatusLocation: currentOrder.pickupAddress?.city || "N/A",
                                StatusDateTime: new Date(Date.now() + 5.5 * 60 * 60 * 1000),
                                Instructions: "Order booked successfully",
                            }
                        }
                    },
                    { session }
                ),
                Wallet.updateOne(
                    { _id: walletId },
                    {
                        $inc: { balance: -balanceToBeDeducted },
                    },
                    { session }
                ),
                WalletTransaction.create(
                    [
                        {
                            walletId: walletId,
                            channelOrderId: currentOrder.orderId,
                            category: "debit",
                            amount: balanceToBeDeducted,
                            balanceAfterTransaction: walletBalance - balanceToBeDeducted,
                            date: new Date(),
                            awb_number: awb,
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
                awb_number: awb,
            };
        } catch (error) {
            if (session.inTransaction()) {
                await session.abortTransaction();
            }
            session.endSession();

            const isTransient =
                error.errorLabels?.includes("TransientTransactionError") ||
                error.code === 112 ||
                error.message?.includes("WriteConflict");

            if (isTransient && attempt < maxRetries) {
                console.warn(`[API BoxdLogistics createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
                await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
                continue;
            }

            console.error(
                "❌ BoxdLogistics API shipment error:",
                error?.response?.data || error.message
            );
            return {
                success: false,
                message:
                    error?.response?.data?.message ||
                    error.message ||
                    "Failed to create shipment",
            };
        }
    }
};

module.exports = createBoxdLogisticsShipment;
