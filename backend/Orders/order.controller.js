if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const Order = require("../models/orderSchema.model");
const Services = require("../models/courierServiceSecond.model");
const Courier = require("../models/courierSecond");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const { checkServiceabilityAll } = require("./shipment.controller");
const { calculateRateForService } = require("../Rate/calculateRateController");
const User = require("../models/User.model");
const {
  requestShipmentPickup,
  cancelOrder,
  getTrackingByAWB,
} = require("../AllCouriers/ShipRocket/Courier/couriers.controller");
const {
  pickup,
  cancelShipmentXpressBees,
  trackShipment,
} = require("../AllCouriers/Xpressbees/MainServices/mainServices.controller");
const {
  cancelShipment,
  trackShipmentNimbuspost,
} = require("../AllCouriers/NimbusPost/Shipments/shipments.controller");
const {
  createPickupRequest,
  cancelOrderDelhivery,
  trackShipmentDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  cancelOrderShreeMaruti,
  trackOrderShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/couriers.controller");
const {
  createShipmentFunctionNimbusPost,
} = require("../AllCouriers/NimbusPost/Shipments/bulkShipment.controller");
const {
  createShipmentFunctionShipRocket,
} = require("../AllCouriers/ShipRocket/Courier/bulkShipment.controller");
const {
  createShipmentFunctionXpressBees,
} = require("../AllCouriers/Xpressbees/MainServices/bulkShipment.controller");
const {
  createShipmentFunctionDelhivery,
} = require("../AllCouriers/Delhivery/Courier/bulkShipment.controller");


const {
  createShipmentFunctionShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/bulkShipment.controller");
const { createOrderShadowfax } = require("../AllCouriers/Shadowfax/Courier/bulkShipment.controller");
const { createShipmentFunctionShipexIndia } = require("../AllCouriers/ShipxIndia/Courier/bulkShipment.controller");
const { cancelShipexIndiaOrder } = require("../AllCouriers/ShipxIndia/Courier/couriers.controller");


const { AutoShip } = require("../Orders/AutoShipB2c.controller");

// Utility function to calculate order totals
function calculateOrderTotals(orderData) {
  let subTotal = 0;
  let productDiscount = 0;

  // Calculate sub-total and product discounts
  orderData.productDetails.forEach((product) => {
    const { quantity, unitPrice, discount = 0 } = product;
    // console.log("quantity:", quantity, "unitprice:", unitPrice, "discount:", discount);

    const productTotal = quantity * unitPrice;
    // console.log("productTotal:", productTotal);

    subTotal += productTotal;
    // console.log("subtotal:", subTotal);

    productDiscount += (productTotal * discount) / 100; // Assuming discount is a percentage
    // console.log("productDiscount:", productDiscount);
  });

  // Calculate other charges
  const shipping = orderData.orderDetails.shippingCharges || 0;
  // console.log("shiping:", shipping);

  const giftWrap = orderData.orderDetails.giftWrap || 0;
  // console.log("giftwrap:", giftWrap);

  // Calculate additional discount on the whole order
  const additionalDiscount = orderData.orderDetails?.additionalDiscount || 0;
  // console.log("additionalDiscount:", additionalDiscount);

  const discountAmount = (subTotal * additionalDiscount) / 100;
  // console.log("discountAmauont:", discountAmount);

  // Total order value calculation
  const totalOrderValue =
    subTotal + shipping + giftWrap - productDiscount - discountAmount;

  return {
    subTotal,
    otherCharges: shipping + giftWrap,
    discount: productDiscount + discountAmount,
    totalOrderValue,
  };
}

// const createOrder = async (req, res) => {
//   try {
//     // console.log("I am in createOrder");
//     const data = req.body.formData;
//     const id = req.body.user._id;
//     const shipping_is_billing = req.body.isSame;

//     const currentUser = await User.findById(id);

//     let newOrder = new Order({
//       order_id: data.orderInfo.orderID,
//       order_type: data.orderInfo.orderType,
//       orderCategory: "B2C-forward",
//       shipping_details: data.shippingInfo,
//       Biling_details: data.billingInfo,
//       Product_details: data.productDetails,
//       shipping_cost: data.shippingCost,
//       status: "Not-Shipped",
//       sub_total: data.sub_total,
//       shipping_is_billing,
//     });

//     let result = await newOrder.save();
//     currentUser.orders.push(result._id);
//     await currentUser.save();
//     res
//       .status(201)
//       .json({ message: "Order created successfully", order: result });
//   } catch (error) {
//     console.error("Error in createOrder:", error);
//     res
//       .status(500)
//       .json({ message: "Failed to create order", error: error.message });
//   }
// };

// const getAllOrders = async (req, res) => {
//   try {
//     const orders = await Order.find({}).populate("service_details");
//     return res.status(201).json(orders);
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// };

const getOrderDetails = async (req, res) => {
  try {
    let id = req.body.id;
    let result = await Order.findById(id).populate("service_details");

    if (!result) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching order details:", error);
    res
      .status(500)
      .json({ message: "Server error, unable to fetch order details" });
  }
};

const shipOrder = async (req, res) => {
  try {
    const currentOrder = await Order.findById(req.body.id);

    const servicesCursor = Services.find({ isEnabeled: true });
    const enabledServices = [];

    for await (const srvc of servicesCursor) {
      const provider = await Courier.findOne({
        provider: srvc.courierProviderName,
      });

      if (provider?.isEnabeled === true && provider?.toEnabeled === false) {
        enabledServices.push(srvc);
      }
    }

    const availableServices = await Promise.all(
      enabledServices.map(async (item) => {
        let result = await checkServiceabilityAll(
          item,
          req.body.id,
          req.body.pincode
        );
        if (result) {
          return item;
        }
      })
    );

    const filteredServices = availableServices.filter(Boolean);
    // console.log("filter",filteredServices);

    const payload = {
      pickupPincode: req.body.pincode,
      deliveryPincode: currentOrder.shipping_details.pinCode,
      length: currentOrder.shipping_cost.dimensions.length,
      breadth: currentOrder.shipping_cost.dimensions.width,
      height: currentOrder.shipping_cost.dimensions.height,
      weight: currentOrder.shipping_cost.weight,
      cod: currentOrder.order_type === "Cash on Delivery" ? "Yes" : "No",
      valueInINR: currentOrder.sub_total,
      filteredServices,
      rateCardType: req.body.plan,
    };

    let rates = await calculateRateForService(payload);

    res.status(201).json({
      success: true,
      services: filteredServices,
      rates,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch services",
      error: error.message,
    });
  }
};

const cancelOrdersAtNotShipped = async (req, res) => {
  const ordersToBeCancelled = req.body.items;

  if (!Array.isArray(ordersToBeCancelled) || ordersToBeCancelled.length === 0) {
    return res
      .status(400)
      .send({
        error:
          "Invalid input. Please provide a valid list of orders to cancel.",
      });
  }

  try {
    const updatePromises = ordersToBeCancelled.map(async (order) => {
      const currentOrder = await Order.findById(order._id);

      if (currentOrder && currentOrder.status !== "Cancelled") {
        currentOrder.status = "Cancelled";
        currentOrder.cancelledAtStage = "Not-Shipped";
        return currentOrder.save();
      }
    });

    await Promise.all(updatePromises);

    const message =
      ordersToBeCancelled.length > 1
        ? "Orders cancelled successfully"
        : "Order has been cancelled successfully";

    res.status(201).send({ message });
  } catch (error) {
    console.error("Error canceling orders:", {
      error,
      orders: ordersToBeCancelled.map((order) => order._id),
    });
    res
      .status(500)
      .send({ error: "An error occurred while cancelling orders." });
  }
};

const requestPickup = async (req, res) => {
  const allOrders = req.body.items;

  if (!allOrders || allOrders.length === 0) {
    return res.status(400).json({ error: "No orders provided." });
  }

  try {
    const results = await Promise.all(
      allOrders.map(async (order) => {
        let currentOrder = await Order.findById(order._id)
          .populate("service_details")
          .populate("warehouse");
        let updateStatus = { orderId: order._id, status: "Failed" };

        if (!currentOrder) {
          updateStatus.error = "Order not found";
          return updateStatus;
        }

        try {
          if (
            currentOrder.service_details.courierProviderName === "NimbusPost"
          ) {
            currentOrder.status = "WaitingPickup";
            currentOrder.tracking.push({
              stage: "Pickup Generated",
            });
            await currentOrder.save();
            updateStatus.status = "WaitingPickup";
          } else if (
            currentOrder.service_details.courierProviderName === "Shiprocket"
          ) {
            const result = await requestShipmentPickup(
              currentOrder.shipment_id
            );
            if (result.success) {
              currentOrder.status = "WaitingPickup";
              currentOrder.pickup_details.pickup_scheduled_date =
                result.data.response.pickup_scheduled_date;
              currentOrder.pickup_details.pickup_token_number =
                result.data.response.pickup_token_number;
              currentOrder.pickup_details.pickup_generated_date =
                result.data.response.pickup_generated_date.date;
              currentOrder.tracking.push({
                stage: "Pickup Generated",
              });
              await currentOrder.save();
              updateStatus.status = "WaitingPickup";
            } else {
              updateStatus.error = "Shiprocket pickup failed";
            }
          } else if (
            currentOrder.service_details.courierProviderName === "Xpressbees"
          ) {
            const result = await pickup([currentOrder.awb_number]);
            if (result.success) {
              currentOrder.status = "WaitingPickup";
              currentOrder.tracking.push({
                stage: "Pickup Generated",
              });
              await currentOrder.save();
              updateStatus.status = "WaitingPickup";
            } else {
              updateStatus.error = "Xpressbees pickup failed";
            }
          } else if (
            currentOrder.service_details.courierProviderName === "Delhivery"
          ) {
            const result = await createPickupRequest(
              currentOrder.warehouse?.warehouseName || "Default Warehouse",
              currentOrder.awb_number,
              currentOrder.pickupAddress
            );
            if (result.success) {
              currentOrder.status = "WaitingPickup";
              currentOrder.pickup_details.pickup_scheduled_date =
                result?.data?.pickup_date;
              currentOrder.pickup_details.pickup_token_number = `${result?.data?.pickup_id}`;
              currentOrder.pickup_details.pickup_time =
                result?.data?.pickup_time;
              currentOrder.pickup_details.pickup_generated_date =
                result?.pickupDate;
              currentOrder.tracking.push({
                stage: "Pickup Generated",
              });
              await currentOrder.save();
              updateStatus.status = "WaitingPickup";
            } else {
              updateStatus.error = "Xpressbees pickup failed";
            }
          } else if (
            currentOrder.service_details.courierProviderName === "ShreeMaruti"
          ) {
            currentOrder.status = "WaitingPickup";
            currentOrder.tracking.push({
              stage: "Pickup Generated",
            });
            await currentOrder.save();
            updateStatus.status = "WaitingPickup";
          } else {
            updateStatus.error = "Unsupported courier provider";
          }
        } catch (error) {
          updateStatus.error = error.message || "Unknown error";
        }

        return updateStatus;
      })
    );

    const successCount = results.filter(
      (r) => r.status === "WaitingPickup"
    ).length;
    const failedCount = results.filter((r) => r.status === "Failed").length;

    return res.status(201).json({
      success: true,
      message: `${successCount} orders updated successfully, ${failedCount} failed.`,
      details: results,
    });
  } catch (error) {
    console.error("Error processing pickup requests:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const cancelOrdersAtBooked = async (req, res) => {
  const allOrders = req.body.items;
  const walletId = req.body.walletId;

  if (!Array.isArray(allOrders) || allOrders.length === 0) {
    return res
      .status(400)
      .send({
        error:
          "Invalid input. Please provide a valid list of orders to cancel.",
      });
  }

  try {
    const currentWallet = await Wallet.findById(walletId).select("balance");

    const ordersFromDb = await Promise.all(
      allOrders.map((order) =>
        Order.findById(order._id).populate("service_details")
      )
    );

    const cancellationResults = await Promise.all(
      ordersFromDb.map(async (currentOrder) => {
        if (!currentOrder) {
          return { error: "Order not found", orderId: currentOrder._id };
        }

        if (
          currentOrder.status === "Not-Shipped" &&
          currentOrder.cancelledAtStage == null
        ) {
          return {
            message: "Order already cancelled",
            orderId: currentOrder._id,
          };
        }

        if (currentOrder.service_details.courierProviderName === "NimbusPost") {
          const result = await cancelShipment(currentOrder.awb_number);
          if (result.error) {
            return {
              error: "Failed to cancel shipment with NimbusPost",
              details: result,
              orderId: currentOrder._id,
            };
          }
        } else if (
          currentOrder.service_details.courierProviderName === "Shiprocket"
        ) {
          const result = await cancelOrder(currentOrder.awb_number);
          if (!result.success) {
            return {
              error: "Failed to cancel shipment with Shiprocket",
              details: result,
              orderId: currentOrder._id,
            };
          } else if (
            currentOrder.service_details.courierProviderName === "Xpressbees"
          ) {
            const result = await cancelShipmentXpressBees(
              currentOrder.awb_number
            );
            if (result.error) {
              return {
                error: "Failed to cancel shipment with NimbusPost",
                details: result,
                orderId: currentOrder._id,
              };
            }
          }
        } else if (
          currentOrder.service_details.courierProviderName === "Delhivery"
        ) {
          // console.log("I am in it");
          const result = await cancelOrderDelhivery(currentOrder.awb_number);
          if (result.error) {
            return {
              error: "Failed to cancel shipment with NimbusPost",
              details: result,
              orderId: currentOrder._id,
            };
          }
        } else if (
          currentOrder.service_details.courierProviderName === "Shree Maruti"
        ) {
          const result = await cancelOrderShreeMaruti(currentOrder.order_id);
          if (result.error) {
            return {
              error: "Failed to cancel shipment with NimbusPost",
              details: result,
              orderId: currentOrder._id,
            };
          }
        } else if (
          currentOrder.service_details?.courierProviderName === "ShipexIndia" ||
          currentOrder.partner === "ShipexIndia"
        ) {
          const result = await cancelShipexIndiaOrder(currentOrder.awb_number);
          if (!result.success) {
            return {
              error: result.error || "Failed to cancel order with ShipexIndia",
              details: result,
              orderId: currentOrder._id,
            };
          }
        } else {

          return {
            error: "Unsupported courier provider",
            orderId: currentOrder._id,
          };
        }

        currentOrder.status = "Not-Shipped";
        currentOrder.cancelledAtStage = "Booked";
        currentOrder.tracking.push({
          stage: "Cancelled",
        });
        let balanceTobeAdded = currentOrder.freightCharges;
        let currentBalance = currentWallet.balance + balanceTobeAdded;

        const cancelTxn = {
          txnType: "Shipping",
          action: "credit",
          category: "credit",
          amount: balanceTobeAdded,
          balanceAfterTransaction: currentWallet.balance + balanceTobeAdded,
          awb_number: `${currentOrder.awb_number}`,
          description: "Cancellation Refund",
        };
        await currentWallet.updateOne({
          $inc: { balance: balanceTobeAdded },
        });
        // 🔁 Dual-write: mirror to WalletTransaction for future migration
        await WalletTransaction.create([{ walletId: currentWallet._id, ...cancelTxn }]);
        currentOrder.freightCharges = 0;
        await currentOrder.save();
        await currentWallet.save();

        return {
          message: "Order cancelled successfully",
          orderId: currentOrder._id,
        };
      })
    );

    let successCount = 0;
    let failureCount = 0;
    cancellationResults.forEach((result) => {
      if (result.error) {
        failureCount++;
      } else {
        successCount++;
      }
    });

    res.status(201).send({
      results: cancellationResults,
      successCount,
      failureCount,
    });
  } catch (error) {
    console.error("Error cancelling orders:", error);
    res
      .status(500)
      .send({ error: "An error occurred while cancelling orders." });
  }
};

const tracking = async (req, res) => {
  // console.log("Tracking initiated");

  try {
    const allOrders = await Promise.all(
      req.body.items.map((order) =>
        Order.findById(order._id).populate("service_details")
      )
    );

    const updateOrderStatus = async (order, status, stage) => {
      if (
        !order.tracking ||
        order.tracking.length === 0 ||
        (order.tracking.length >= 1 &&
          order.tracking[order.tracking.length - 1].stage !== stage)
      ) {
        order.status = status;
        order.tracking = order.tracking || [];
        order.tracking.push({ stage });
        if (status == "cancelled" || status == "canceled") {
          order.status == "Not-Shipped";
          order.cancelledAtStage == null;
        }
        await order.save();
      }
    };

    const trackingPromises = allOrders.map(async (order) => {
      try {
        const { courierProviderName } = order.service_details;
        const { awb_number } = order;
        let result;

        if (courierProviderName === "NimbusPost") {
          result = await trackShipmentNimbuspost(awb_number);
        } else if (courierProviderName === "Shiprocket") {
          result = await getTrackingByAWB(awb_number);
          console.log("Tracking result", result);
        } else if (courierProviderName === "Xpressbees") {
          result = await trackShipment(awb_number);
        } else if (courierProviderName === "Delhivery") {
          result = await trackShipmentDelhivery(awb_number);
        } else if (courierProviderName === "Shree Maruti") {
          result = await trackOrderShreeMaruti(awb_number);
        }

        if (result && result.success) {
          const status = result.data.toLowerCase().replace(/_/g, " ");

          const statusMap = {
            cancelled: () =>
              updateOrderStatus(order, "Not-Shipped", "Cancelled"),
            canceled: () =>
              updateOrderStatus(order, "Not-Shipped", "Cancelled"),
            "out for delivery": () =>
              updateOrderStatus(order, "Out For Delivery", "Out For Delivery"),
            "in transit": () =>
              updateOrderStatus(order, "In Transit", "In Transit"),
            delivered: () => updateOrderStatus(order, "Delivered", "Delivered"),
            delayed: () => updateOrderStatus(order, "Delayed", "Delayed"),
          };

          if (statusMap[status]) {
            await statusMap[status]();
          }
        }
      } catch (error) {
        console.error(
          `Error processing order ID: ${order._id}, AWB: ${order.awb_number}`,
          error
        );
      }
    });

    await Promise.all(trackingPromises);

    res.status(200).json({ message: "Tracking updated successfully" });
  } catch (error) {
    console.error("Error in tracking:", error);
    res.status(500).json({ message: "Internal server error", error });
  }
};

const editOrder = async (req, res) => {
  try {
    const { formData, isSame, id } = req.body;

    if (!id || !formData) {
      return res
        .status(400)
        .json({ message: "Order ID and form data are required" });
    }

    const result = await Order.findByIdAndUpdate(
      id,
      {
        order_id: formData.orderInfo.orderID,
        order_type: formData.orderInfo.orderType,
        orderCategory: "B2C-forward",
        shipping_details: formData.shippingInfo,
        billing_details: formData.billingInfo,
        product_details: formData.productDetails,
        shipping_cost: formData.shippingCost,
        status: "Not-Shipped",
        sub_total: formData.sub_total,
        shipping_is_billing: isSame,
      },
      { new: true }
    );

    if (!result) {
      return res.status(404).json({ message: "Order not found" });
    }

    res
      .status(201)
      .json({ message: "Order updated successfully", order: result });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to update order", error: error.message });
  }
};

const shipBulkOrder = async (req, res) => {
  try {
    const { id, pincode, plan, isBulkShip } = req.body;
    const servicesCursor = Services.find({ isEnabeled: true });
    const enabledServices = [];

    for await (const srvc of servicesCursor) {
      const provider = await Courier.findOne({
        provider: srvc.courierProviderName,
      });
      if (provider?.isEnabeled === true && provider?.toEnabeled === false) {
        enabledServices.push(srvc);
      }
    }

    const availableServices = await Promise.all(
      id.map(async (item) => {
        const serviceable = await Promise.all(
          enabledServices.map(async (svc) => {
            const result = await checkServiceabilityAll(svc, item._id, pincode);
            return result ? svc : null;
          })
        );
        return serviceable.filter(Boolean);
      })
    );

    const flattenedAvailableServices = [...new Set(availableServices.flat())];

    res.status(201).json({
      success: true,
      services: flattenedAvailableServices,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch services",
      error: error.message,
    });
  }
};

const createBulkOrder = async (req, res) => {
  console.log("Bulk order creation initiated");
  console.log(req.body);

  let successCount = 0;
  let failureCount = 0;

  const { walletId, availableServices, userId } = req.body;
  const { selectedServiceDetails, id, wh } = req.body.payload;

  const servicesToBeConsidered = availableServices.filter(
    (item) => item.courierProviderServiceName !== "AutoShip"
  );

  const remainingOrders = [...id];

  try {
    if (!Array.isArray(id) || id.length === 0) {
      return res
        .status(400)
        .json({ error: "No orders provided for bulk creation." });
    }

    if (
      selectedServiceDetails?.courierProviderName === "AutoShip" ||
      selectedServiceDetails?.courierProviderServiceName === "AutoShip"
    ) {
      const autoShipPromises = id.map(async (order) => {
        const priorityServices = await AutoShip(order, wh, userId);

        if (priorityServices.length > 0) {
          const validPriorityServices = priorityServices
            .sort((a, b) => a.priority - b.priority)
            .filter((service) =>
              servicesToBeConsidered.some(
                (availableService) =>
                  availableService.courierProviderServiceName ===
                  service.courierProviderServiceName
              )
            );

          for (let service of validPriorityServices) {
            try {
              const isServiceable = await checkServiceabilityAll(
                service,
                order,
                `${wh.pinCode}`
              );
              if (!isServiceable) {
                continue;
              }

              // Calculate charges before creating the shipment
              const details = {
                pickupPincode: `${wh.pinCode}`,
                deliveryPincode: `${order.shipping_details.pinCode}`,
                length: order.shipping_cost.dimensions.length,
                breadth: order.shipping_cost.dimensions.width,
                height: order.shipping_cost.dimensions.height,
                weight: order.shipping_cost.weight,
                cod: order.order_type === "Cash on Delivery" ? "Yes" : "No",
                valueInINR: order.sub_total,
              };

              const rates = await calculateRateForService(details);
              const charges = parseInt(rates[0]?.forward?.finalCharges);

              if (!charges) {
                throw new Error("Invalid charges calculated.");
              }

              const result = await createShipment(
                service,
                order,
                wh,
                walletId,
                charges
              );

              if (result?.status === 200) {
                successCount++;
                remainingOrders.splice(remainingOrders.indexOf(order), 1);
                break;
              }
            } catch (error) {
              console.error(
                `Error processing AutoShip order ${order._id}:`,
                error
              );
            }
          }
        }
      });

      await Promise.all(autoShipPromises);

      // Handle fallback for remaining orders
      if (remainingOrders.length > 0) {
        const fallbackPromises = remainingOrders.map(async (order) => {
          let shipmentCreated = false;

          for (let service of servicesToBeConsidered) {
            try {
              const isServiceable = await checkServiceabilityAll(
                service,
                order,
                `${wh.pinCode}`
              );

              if (isServiceable) {
                const result = await createShipment(
                  service,
                  order,
                  wh,
                  walletId,
                  selectedServiceDetails
                );

                if (result?.status === 200) {
                  successCount++;
                  shipmentCreated = true;
                  remainingOrders.splice(remainingOrders.indexOf(order), 1);
                  break;
                } else {
                  console.warn(
                    `Shipment creation failed for order ${order._id} with service ${service.courierProviderName}.`
                  );
                }
              }
            } catch (error) {
              console.error(
                `Error checking serviceability for order ${order._id} with service ${service.courierProviderName}:`,
                error
              );
            }
          }

          if (!shipmentCreated) {
            failureCount++;
            console.warn(`No serviceable option found for order ${order._id}.`);
          }
        });

        await Promise.all(fallbackPromises);
      }

      return res.status(201).json({
        message: `${successCount} orders created successfully & ${failureCount} failed.`,
        successCount,
        failureCount,
        remainingOrdersCount: remainingOrders.length,
        remainingOrders,
      });
    }

    // Handle non-AutoShip orders
    const orderPromises = id.map(async (order) => {
      const details = {
        pickupPincode: `${wh.pinCode}`,
        deliveryPincode: `${order.shipping_details.pinCode}`,
        length: order.shipping_cost.dimensions.length,
        breadth: order.shipping_cost.dimensions.width,
        height: order.shipping_cost.dimensions.height,
        weight: order.shipping_cost.weight,
        cod: order.order_type === "Cash on Delivery" ? "Yes" : "No",
        valueInINR: order.sub_total,
        filteredServices: [selectedServiceDetails],
        rateCardType: req.body.plan,
      };

      try {
        const rates = await calculateRateForService(details);
        const charges = parseInt(rates[0]?.forward?.finalCharges);
        // const charges=70;

        if (!charges) {
          throw new Error("Invalid charges calculated.");
        }

        const result = await createShipment(
          selectedServiceDetails,
          order,
          wh,
          walletId,
          charges
        );

        console.log("Bulk Shipment Result is:", result);

        if (result) {
          successCount++;
          remainingOrders.splice(remainingOrders.indexOf(order), 1);
        } else {
          failureCount++;
        }
      } catch (error) {
        console.error(`Error processing order ${order._id}:`, error);
        failureCount++;
      }
    });

    await Promise.all(orderPromises);

    return res.status(201).json({
      message: `${successCount} orders created successfully & ${failureCount} failed.`,
      successCount,
      failureCount,
      remainingOrdersCount: remainingOrders.length,
      remainingOrders,
    });
  } catch (error) {
    console.error("Error in creating bulk orders:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
      successCount,
      failureCount,
      remainingOrdersCount: remainingOrders.length,
      remainingOrders,
    });
  }
};

const createShipment = async (serviceDetails, order, wh, walletId, charges) => {
  try {
    let result;

    switch (serviceDetails.courierProviderName) {
      case "NimbusPost":
        result = await createShipmentFunctionNimbusPost(
          serviceDetails,
          order._id,
          wh,
          walletId,
          charges
        );
        break;
      case "Shiprocket":
        result = await createShipmentFunctionShipRocket(
          serviceDetails,
          order._id,
          wh,
          walletId,
          charges
        );
        break;
      case "Xpressbees":
        result = await createShipmentFunctionXpressBees(
          serviceDetails,
          order._id,
          wh,
          walletId,
          charges
        );
        break;
      case "Delhivery":
        result = await createShipmentFunctionDelhivery(
          serviceDetails,
          order._id,
          wh,
          walletId,
          charges
        );
        break;
      case "Shree Maruti":
        result = await createShipmentFunctionShreeMaruti(
          serviceDetails,
          order._id,
          wh,
          walletId,
          charges
        );
        break;
      case "Shadowfax":
        result = await createOrderShadowfax(
          serviceDetails,
          order._id,
          wh,
          walletId,
          charges
        );
        break;
      case "ShipexIndia":
        result = await createShipmentFunctionShipexIndia(
          serviceDetails,
          order._id,
          wh,
          walletId,
          charges
        );
        break;
      default:

        console.error(
          `No function defined for ${serviceDetails.courierProviderName}`
        );
        return false;
    }

    return result?.status === 200 || result?.status === 201;
  } catch (error) {
    console.error(`Error creating shipment:`, error);
    return false;
  }
};

module.exports = {
  createOrder,
  getAllOrders,
  getOrderDetails,
  shipOrder,
  cancelOrdersAtNotShipped,
  requestPickup,
  cancelOrdersAtBooked,
  tracking,
  editOrder,
  shipBulkOrder,
  // shipBulkOrder,
  createBulkOrder
};
