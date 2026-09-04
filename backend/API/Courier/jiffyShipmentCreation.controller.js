const mongoose = require("mongoose");
const Order = require("../../models/newOrder.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const { getZone } = require("../../Rate/zoneManagementController");
const { bookJiffyShipment, extractJiffyErrorMessage } = require("../../AllCouriers/Jiffy/Courier/couriers.controller");
const { assignPickupManifest } = require("../../Orders/scheduledPickup.controller");

const revertOrderToNew = async (id) => {
    try {
        await Order.updateOne({ _id: id, status: "processing" }, { $set: { status: "new" } });
    } catch (revertErr) {
        console.error("[Jiffy] Failed to revert order status after failure:", revertErr.message);
    }
};

const createJiffyShipment = async ({
    id,
    provider,
    finalCharges,
    courierServiceName,
    courier,       // Jiffy courier_code from CourierService.courier
    priceBreakup,
    userId,
    walletId,
    walletBalance,
    walletHoldAmount,
    walletCreditLimit,
}) => {
    // Step 1: atomically lock the order — a single findOneAndUpdate is already
    // atomic on its own, no transaction needed just for this.
    const currentOrder = await Order.findOneAndUpdate(
        { _id: id, status: "new" },
        { $set: { status: "processing" } },
        { new: true }
    );

    if (!currentOrder) {
        return {
            success: false,
            message: "Shipment already created or order is being processed.",
        };
    }

    try {
        const hold = walletHoldAmount || 0;
        const effectiveBalance = walletBalance - hold;
        const balance = effectiveBalance + (walletCreditLimit || 0);
        if (balance < finalCharges) {
            await revertOrderToNew(id);
            return { success: false, message: "Insufficient wallet balance" };
        }

        const zone = await getZone(
            currentOrder.pickupAddress.pinCode,
            currentOrder.receiverAddress.pinCode
        );
        if (!zone) {
            await revertOrderToNew(id);
            return { success: false, message: "Pincode not serviceable" };
        }

        // Step 2: call Jiffy exactly once. This is intentionally OUTSIDE the
        // write-retry loop below — retrying a transient Mongo write conflict
        // must never re-call the external API, or it would create a second,
        // duplicate shipment at Jiffy for the same order.
        let shipmentData;
        try {
            shipmentData = await bookJiffyShipment(currentOrder, courier);
            console.log("Jiffy API create response:", shipmentData);
        } catch (err) {
            await revertOrderToNew(id);
            return { success: false, message: extractJiffyErrorMessage(err, "Failed to create shipment") };
        }

        const awb = shipmentData.awb_number;
        const balanceToBeDeducted = parseFloat(finalCharges) || 0;
        const providerWord = (shipmentData.courier_name || courierServiceName).split(" ")[0];

        // Step 3: commit Order status + wallet debit + ledger entry together.
        // Only THIS part is retried on a transient write conflict.
        const maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            attempt++;
            const session = await mongoose.startSession();

            try {
                session.startTransaction();

                await Promise.all([
                    Order.findByIdAndUpdate(
                        id,
                        {
                            $set: {
                                status: "Booked",
                                awb_number: awb,
                                shipment_id: String(shipmentData.id || ""),
                                provider: providerWord,
                                partner: "Jiffy",
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
                        { $inc: { balance: -balanceToBeDeducted } },
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
                    console.warn(`[API Jiffy createShipment] Write conflict on attempt ${attempt}. Retrying in ${50 * attempt}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
                    continue;
                }

                // Jiffy already created a real shipment (we have its AWB) but
                // Shiproxx failed to record it after all retries — surface this
                // loudly since it needs manual reconciliation, and revert the
                // order so it isn't stuck in "processing" forever.
                console.error(
                    `🚨 JIFFY ORPHANED SHIPMENT — order ${currentOrder.orderId} booked at Jiffy with AWB ${awb} but Shiproxx failed to save it after ${attempt} attempts. Manual reconciliation required.`,
                    error?.response?.data || error.message
                );
                await revertOrderToNew(id);
                return {
                    success: false,
                    message: `Shipment was booked with the courier (AWB ${awb}) but could not be saved — please contact support.`,
                };
            }
        }
    } catch (error) {
        await revertOrderToNew(id);
        console.error(
            "❌ Jiffy API shipment error:",
            error?.response?.data || error.message
        );
        return {
            success: false,
            message:
                error?.response?.data?.error?.message ||
                error.message ||
                "Failed to create shipment",
        };
    }
};

module.exports = createJiffyShipment;
