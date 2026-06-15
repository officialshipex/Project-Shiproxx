const Order = require("../models/newOrder.model");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const User = require("../models/User.model");
const DTDCStatusMapping = require("../statusMap/DTDCStatusMapping");
const SmartShipStatusMapping = require("../statusMap/SmartShipStatusMapping");
const DelhiveryStatusMapping = require("../statusMap/DelhiveryStatusMapping");
const AmazonStatusMapping = require("../statusMap/AmazonStatusMapping");
const ecomExpressStatusMapping = require("../statusMap/EcomStatusMapping");
const ZipyPostScanCodeMapping = require("../statusMap/ZipypostStatusMapping");

const cron = require("node-cron");
const {
  shipmentTrackingforward,
} = require("../AllCouriers/EcomExpress/Couriers/couriers.controllers");
const {
  trackShipment,
} = require("../AllCouriers/Xpressbees/MainServices/mainServices.controller");
const {
  trackShipmentDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  getShipmentTracking,
} = require("../AllCouriers/Amazon/Courier/couriers.controller");
const {
  trackOrderShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/couriers.controller");
const {
  trackOrderDTDC,
} = require("../AllCouriers/DTDC/Courier/couriers.controller");
const {
  trackOrderSmartShip,
} = require("../AllCouriers/SmartShip/Couriers/couriers.controller");
const {
  trackOrderZipypost,
} = require("../AllCouriers/Zipypost/Couriers/couriers.controller");
const {
  trackOrderBoxdLogistics,
} = require("../AllCouriers/BoxdLogistics/Courier/couriers.controller");
const {
  trackProshipOrder,
} = require("../AllCouriers/Proship/Courier/couriers.controller");
const {
  getTrackingByAWB: trackShiprocketOrder,
} = require("../AllCouriers/ShipRocket/Courier/couriers.controller");
const {
  trackShadowfaxOrder,
} = require("../AllCouriers/Shadowfax/Courier/couriers.controller");
const {
  trackEkartShipment,
} = require("../AllCouriers/Ekart/Couriers/couriers.controller");
const {
  trackLosung360Order,
} = require("../AllCouriers/Losung360/Courier/couriers.controller");
const Bottleneck = require("bottleneck");
const {
  sendWhatsAppMessage,
  sendEmailMessage,
  sendSMSMessage,
} = require("../notification/notification.controller");
const { markWooOrderAsShipped } = require("../Channels/WooCommerce/woocommerce.controller");

const statusMap = require("../statusMap/StatusMap.model");

const limiter = new Bottleneck({
  minTime: 1000, // 10 requests per second (1000ms delay between each)
  maxConcurrent: 10, // Maximum 10 at the same time
  reservoir: 750, // Max 750 calls per minute
  reservoirRefreshAmount: 750,
  reservoirRefreshInterval: 60 * 1000, // Refresh every 1 minute
});

const trackSingleOrder = async (order) => {
  try {
    // console.log("Tracking order:", order.awb_number);
    const { provider, awb_number, shipment_id, partner } = order;
    if (!provider || !awb_number) return;

    const currentWallet = await Wallet.findById(
      (await User.findById((await Order.findOne({ awb_number })).userId))
        .Wallet,
    ).select("_id");

    const trackingFunctions = {
      Xpressbees: trackShipment,
      Delhivery: trackShipmentDelhivery,
      "Shree Maruti": trackOrderShreeMaruti,
      ShreeMaruti: trackOrderShreeMaruti,
      DTDC: trackOrderDTDC,
      Dtdc: trackOrderDTDC,
      EcomExpress: shipmentTrackingforward,
      "Amazon Shipping": getShipmentTracking,
      Amazon: getShipmentTracking,
      Smartship: trackOrderSmartShip,
      ZipyPost: trackOrderZipypost,
      BoxdLogistics: trackOrderBoxdLogistics,
      Proship: trackProshipOrder,
      Shiprocket: trackShiprocketOrder,
      Shadowfax: trackShadowfaxOrder,
      Ekart: trackEkartShipment,
      Losung360: trackLosung360Order,
    };

    // if (!trackingFunctions[provider]) {
    //   console.warn(`Unknown provider: ${provider} for Order ID: ${order._id}`);
    //   return;
    // }
    let result;
    if (partner && partner === "ZipyPost") {
      result = await trackingFunctions["ZipyPost"](awb_number, shipment_id);
    } else if (partner && partner === "BoxdLogistics") {
      result = await trackingFunctions["BoxdLogistics"](awb_number, shipment_id);
    } else if (partner && partner === "Proship") {
      result = await trackingFunctions["Proship"](awb_number, shipment_id);
    } else if (partner && partner === "Losung360") {
      result = await trackingFunctions["Losung360"](awb_number);
    } else if (partner && partner === "Shiprocket") {
      result = await trackingFunctions["Shiprocket"](awb_number);
    } else if (partner && partner === "Shadowfax") {
      result = await trackingFunctions["Shadowfax"](awb_number);
    } else if (provider && provider === "Shadowfax") {
      result = await trackingFunctions["Shadowfax"](awb_number);
    } else if (provider && trackingFunctions[provider]) {
      result = await trackingFunctions[provider](awb_number, shipment_id);
    } else {
      console.warn(
        `Unknown provider/partner: provider=${provider}, partner=${partner} for Order ID: ${order._id}`,
      );
      return;
    }
    if (!result || !result.success || !result.data) return;
    const latestTrackingEvent = Array.isArray(result.data)
      ? result.data[result.data.length - 1] // last (most recent)
      : result.data;

    // Normalize only the latest one
    const normalizedData = mapTrackingResponse(
      [result.data],
      (partner === "ZipyPost" || partner === "BoxdLogistics" || partner === "Proship" || partner === "Shiprocket" || partner === "Ekart" || partner === "Losung360") ? partner : provider,
    );
    // console.log("normalized", normalizedData);

    if (!normalizedData) {
      console.warn(`Failed to map tracking data for AWB: ${awb_number}`);
      return;
    }
    let shouldUpdateWallet = false;
    let balanceTobeAdded = 0;

    if (provider === "EcomExpress") {
      const instruction = normalizedData.Instructions?.toLowerCase();
      order.status = ecomExpressStatusMapping[instruction];

      if (ecomExpressStatusMapping[instruction] === "Out for Delivery") {
        order.ndrStatus = "Out for Delivery";
      }
      // console.log("status", normalizedData.Status, normalizedData.Instructions);

      if (order.status === "RTO In-transit" && result.rto_awb) {
        order.awb_number = result.rto_awb;
      } else {
        order.awb_number = result.data.awb_number;
      }
      if (
        normalizedData.Status === "Returned" &&
        normalizedData.Instructions === "Undelivered"
      ) {
        // console.log("rto", order.awb_number);
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
      }
      if (
        (order.status === "RTO" || order.status === "RTO In-transit") &&
        (instruction === "bagged" ||
          instruction === "bag added to connection" ||
          instruction === "departed from location" ||
          instruction === "bag inscan at location" ||
          instruction === "shipment debagged at location")
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
      }
      if (
        (order.ndrStatus === "Undelivered" ||
          order.ndrStatus === "Out for Delivery") &&
        normalizedData.Instructions === "Delivered"
      ) {
        order.ndrStatus = "Delivered";
      }

      if (
        normalizedData.Instructions === "Undelivered" &&
        order.ndrStatus !== "Action_Requested" &&
        normalizedData.Instructions !== "Out for delivery"
      ) {
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";
        order.ndrReason = {
          date: normalizedData.StatusDateTime,
          reason: normalizedData.ReasonCode,
        };
        // if (!Array.isArray(order.ndrHistory)) {
        //   order.ndrHistory = [];
        // }
        const lastEntryDate = new Date(
          order.ndrHistory[order.ndrHistory.length - 1]?.date,
        ).toDateString();
        const currentStatusDate = new Date(
          normalizedData.StatusDateTime,
        ).toDateString();

        if (
          order.ndrHistory.length === 0 ||
          lastEntryDate !== currentStatusDate
        ) {
          const attemptCount = order.ndrHistory?.length || 0;
          if (normalizedData.Instructions === "Undelivered") {
            // console.log("ecom", normalizedData.ReasonCode);
            order.reattempt = true;
            order.ndrHistory.push({
              date: normalizedData.StatusDateTime,
              action: "Auto Reattempt",
              remark: normalizedData.ReasonCode,
              attempt: attemptCount + 1,
            });
          }
        }
      }

      if (
        (order.status === "RTO" || order.status === "RTO In-transit") &&
        instruction === "delivered"
      ) {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
      }
    }
    if (provider === "Dtdc" || provider === "DTDC") {
      const statusDoc = await statusMap.findOne(
        { partnerName: provider.toUpperCase() },
        { data: 1 },
      );

      if (statusDoc) {
        // match by code (case-insensitive)
        // console.log("nor",normalizedData.Status)
        const dbMapping = statusDoc.data.find(
          (d) => d.code?.toLowerCase() === normalizedData.Status?.toLowerCase(),
        );
        // console.log("db mapping dtdc", dbMapping);
        if (dbMapping) {
          console.log("maped dtdc status", dbMapping.sy_status);
          order.status = dbMapping.sy_status;
          order.ndrStatus = dbMapping.sy_status;
          if (dbMapping.sy_status === "In-transit" && !order.invoiceDate) {
            order.invoiceDate = normalizedData.StatusDateTime;
          }
          if (
            dbMapping.sy_status === "Cancelled" &&
            order.tracking.length > 3
          ) {
            order.status = "RTO";
          }
          if (dbMapping.code === "SETRTO") {
            if (order.ndrStatus !== "Action_Requested") {
              order.reattempt = true;
            } else {
              order.reattempt = false;
            }
          } else {
            order.reattempt = false;
          }
          // console.log("db mapping",dbMapping.sy_status)
          // Only set ndrStatus for actual NDR-related states
          if (
            [
              "Our for Delivery",
              "RTO",
              "Undelivered",
              "In-transit",
              "RTO In-transit",
              "RTO Delivered",
            ].includes(dbMapping.sy_status)
          ) {
            order.ndrStatus = dbMapping.sy_status;
          }
          if (order.status === "RTO" || order.status === "RTO In-transit") {
            order.ndrStatus = order.status;
          }
          if (order.status === "RTO Delivered") {
            order.ndrStatus = "RTO Delivered";
          }
          if (
            (order.ndrStatus === "Undelivered" ||
              order.ndrStatus === "Out for Delivery" ||
              order.ndrStatus === "Action_Requested") &&
            dbMapping.code === "DLV"
          ) {
            if (order.ndrHistory.length > 0) {
              // Delivered but NDR was raised → mark both
              order.status = "Delivered";
              order.ndrStatus = "Delivered";
            } else {
              // Delivered without NDR → only order.status
              order.status = "Delivered";
            }
          }
          const trackingLength = order.tracking?.length || 0;
          const previousStatus =
            trackingLength >= 2
              ? order.tracking[trackingLength - 2]?.status
              : null;
          if (
            normalizedData.Instructions ===
            "Return as per client instruction." &&
            (trackingLength === 0 ||
              (previousStatus !== "NONDLV" &&
                previousStatus !== "Not Delivered" &&
                previousStatus !== "SETRTO"))
          ) {
            // console.log("awb with number", awb_number);
            order.status = "Cancelled";
            order.ndrStatus = "Cancelled";
            balanceTobeAdded =
              order.totalFreightCharges === "N/A"
                ? 0
                : parseFloat(order.totalFreightCharges);
            shouldUpdateWallet = true;
          }

          if (normalizedData.Status === "SETRTO") {
            if (order.ndrStatus !== "Action_Requested") {
              order.reattempt = true;
            } else {
              order.reattempt = false;
            }
          } else {
            order.reattempt = false;
          }

          if (
            dbMapping.sy_status === "Undelivered" ||
            dbMapping.code === "RTONONDLV"
          ) {
            order.status = "Undelivered";
            order.ndrStatus = "Undelivered";
            // updateNdrHistoryByAwb(order.awb_number);
            order.ndrReason = {
              date: normalizedData.StatusDateTime,
              reason: normalizedData.StrRemarks,
            };
            // if (!Array.isArray(order.ndrHistory)) {
            //   order.ndrHistory = [];
            // }
            const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
            const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];

            const lastEntryDate = lastAction?.date
              ? new Date(lastAction.date).getTime()
              : null;
            const currentStatusDate = new Date(
              normalizedData.StatusDateTime,
            ).getTime();

            if (
              (lastEntryDate !== currentStatusDate ||
                order.ndrHistory.length === 0) &&
              order.ndrHistory.length <= 2
            ) {
              const attemptCount = order.ndrHistory?.length + 1 || 0;
              if (dbMapping.sy_status === "Undelivered") {
                // Create a new history entry with one action inside
                const newHistoryEntry = {
                  actions: [
                    {
                      action: `NDR ${attemptCount} Raised`,
                      actionBy: order.courierServiceName,
                      remark: normalizedData.StrRemarks,
                      source: order.provider,
                      date: normalizedData.StatusDateTime,
                    },
                  ],
                };

                order.ndrHistory.push(newHistoryEntry);
              }
            }
          }
        }
      }
    }
    if (provider === "Amazon Shipping" || provider === "Amazon") {
      // console.log("normaliz", normalizedData);
      if (normalizedData.ShipmentType === "FORWARD") {
        if (normalizedData.Instructions === "ReadyForReceive") {
          order.status = "Ready To Ship";
          order.ndrStatus = "Ready To Ship";
        }
        if (normalizedData.Instructions === "PickupCancelled") {
          order.status = "Cancelled";
          order.ndrStatus = "Cancelled";
          balanceTobeAdded =
            order.totalFreightCharges === "N/A"
              ? 0
              : parseFloat(order.totalFreightCharges);
          shouldUpdateWallet = true;
        }
        // console.log("amazon instr", normalizedData);
        if (
          normalizedData.Instructions === "PickupDone" ||
          normalizedData.Instructions === "ArrivedAtCarrierFacility" ||
          normalizedData.Instructions === "Departed"
        ) {
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
          if (!order.invoiceDate) {
            order.invoiceDate = normalizedData.StatusDateTime;
          }
          order.reattempt = false;
        }

        if (normalizedData.Instructions === "OutForDelivery") {
          order.status = "Out for Delivery";
          order.ndrStatus = "Out for Delivery";
          order.reattempt = false;
        }
        // console.log("amazon", normalizedData);
        if (normalizedData.Instructions === "Delivered") {
          order.status = "Delivered";
          order.ndrStatus = "";
          order.reattempt = false;
        }

        if (
          (order.ndrStatus === "Undelivered" ||
            order.ndrStatus === "Out for Delivery" ||
            order.ndrStatus === "Action_Requested") &&
          normalizedData.Instructions === "Delivered"
        ) {
          order.ndrStatus = "Delivered";
          order.reattempt = false;
        }

        // Detect Delivery Attempted
        // const secondLastTracking =
        //   Array.isArray(order.tracking) && order.tracking.length >= 2
        //     ? order.tracking[order.tracking.length - 2]
        //     : null;

        // normalizedData.Instructions === "DeliveryAttempted"
        // wasPreviousDeliveryAttempted
        // )
        // if (order.ndrStatus !== "Action_Requested") {
        //   order.status = "Undelivered";
        //   order.ndrStatus = "Undelivered";

        //   order.ndrReason = {
        //     date: normalizedData.StatusDateTime,
        //     reason: normalizedData.StrRemarks,
        //   };

        //   const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
        //   const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];

        //   const lastEntryDate = lastAction?.date
        //     ? new Date(lastAction.date).getTime()
        //     : null;

        //   const currentStatusDate = new Date(
        //     normalizedData.StatusDateTime
        //   ).getTime();

        //   if (
        //     (order.ndrHistory.length === 0 ||
        //       lastEntryDate !== currentStatusDate) &&
        //     order.ndrHistory.length <= 2
        //   ) {
        //     order.reattempt = true;
        //     const attemptCount = order.ndrHistory?.length + 1 || 0;

        //     const newHistoryEntry = {
        //       actions: [
        //         {
        //           action: `NDR ${attemptCount} Raised`,
        //           actionBy: order.courierServiceName,
        //           remark: normalizedData.StrRemarks,
        //           source: order.provider,
        //           date: normalizedData.StatusDateTime,
        //         },
        //       ],
        //     };

        //     order.ndrHistory.push(newHistoryEntry);
        //   }
        // }
      } else {
        // RTO flow
        if (
          normalizedData.Instructions === "ReturnInitiated" &&
          order.status === "Undelivered"
        ) {
          order.status = "RTO";
          order.ndrStatus = "RTO";
        }

        if (
          normalizedData.Instructions === "ArrivedAtCarrierFacility" ||
          normalizedData.Instructions === "Departed" ||
          normalizedData.Instructions ===
          "Package arrived at the carrier facility" ||
          normalizedData.Instructions ===
          "Package has left the carrier facility"
        ) {
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
        }

        if (normalizedData.Instructions === "ReturnInitiated") {
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
        }

        if (normalizedData.Instructions === "Delivered") {
          order.status = "RTO Delivered";
          order.ndrStatus = "RTO Delivered";
        }
      }
    }
    if (provider === "Smartship") {
      const instruction = normalizedData.Instructions?.toLowerCase();
      const Status = normalizedData.Status?.toLowerCase();
      order.status = SmartShipStatusMapping[Status];

      if (
        SmartShipStatusMapping[Status] === "In-transit" &&
        !order.invoiceDate
      ) {
        order.invoiceDate = normalizedData.StatusDateTime;
      }

      if (order.status === "RTO") {
        order.ndrStatus = "RTO";
      }

      if (
        instruction !== "rto  shipper request" &&
        normalizedData.Status === "Return To Origin"
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
      }

      if (SmartShipStatusMapping[instruction] === "Out for Delivery") {
        order.ndrStatus = "Out for Delivery";
      }

      if (
        (order.ndrStatus === "Undelivered" ||
          order.ndrStatus === "Out for Delivery" ||
          order.ndrStatus === "Action_Requested") &&
        (instruction === "shipment delivered" ||
          normalizedData.Instructions === "Delivery Confirmed by Customer")
      ) {
        order.ndrStatus = "Delivered";
      }

      // --- NDR Case ---
      if (
        SmartShipStatusMapping[instruction] === "Undelivered" &&
        (normalizedData.Instructions === "CONSIGNEE REFUSED TO ACCEPT" ||
          normalizedData.Instructions ===
          "CONSIGNEE NOT AVAILABLE CANT DELIVER")
      ) {
        order.status = "Undelivered";

        updateNdrHistoryByAwb(order.awb_number);

        order.ndrReason = {
          date: normalizedData.StatusDateTime,
          reason: normalizedData.StrRemarks,
        };

        const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
        const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];

        const lastEntryDate = lastAction?.date
          ? new Date(lastAction.date).toDateString()
          : null;

        const currentStatusDate = new Date(
          normalizedData.StatusDateTime,
        ).toDateString();

        if (
          (order.ndrHistory.length === 0 ||
            lastEntryDate !== currentStatusDate) &&
          order.ndrHistory.length <= 2
        ) {
          order.ndrStatus = "Undelivered";
          order.reattempt = true;
          const attemptCount = order.ndrHistory?.length + 1 || 0;
          // Create new structured history entry
          const newHistoryEntry = {
            actions: [
              {
                action: `NDR ${attemptCount} Raised`,
                actionBy: order.courierServiceName,
                remark: normalizedData.StrRemarks,
                source: order.provider,
                date: normalizedData.StatusDateTime,
              },
            ],
          };

          order.ndrHistory.push(newHistoryEntry);
        }
      }
      // console.log("norma", normalizedData);
      if (
        normalizedData.Status === "RTO Delivered To Shipper" &&
        normalizedData.Instructions === "SHIPMENT DELIVERED"
      ) {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
      }

      if (
        (instruction === "delivered" ||
          instruction === "delivery confirmed by customer") &&
        normalizedData.Status !== "RTO Delivered To Shipper"
      ) {
        order.status = "Delivered";
      }
    }
    if (provider === "Vamaship") {
      const instruction = normalizedData.Instructions?.toLowerCase();
      // console.log("Smartship instruction", instruction);
      order.status = SmartShipStatusMapping[instruction];
      if (order.status === "RTO") {
        order.ndrStatus = "RTO";
      }
      // console.log("Smartship instruction", instruction);
      if (
        instruction !== "rto  shipper request" &&
        normalizedData.Status === "Return To Origin"
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
      }

      if (SmartShipStatusMapping[instruction] === "Out for Delivery") {
        order.ndrStatus = "Out for Delivery";
      }
      if (
        (order.ndrStatus === "Undelivered" ||
          order.ndrStatus === "Out for Delivery") &&
        (instruction === "shipment delivered" ||
          normalizedData.Instructions === "Delivery Confirmed by Customer")
      ) {
        order.ndrStatus = "Delivered";
      }
      if (SmartShipStatusMapping[instruction] === "Undelivered") {
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";
        order.reattempt = true;
        updateNdrHistoryByAwb(order.awb_number);
        order.ndrReason = {
          date: normalizedData.StatusDateTime,
          reason: normalizedData.StrRemarks,
        };
        // if (!Array.isArray(order.ndrHistory)) {
        //   order.ndrHistory = [];
        // }
        const lastEntryDate = new Date(
          order.ndrHistory[order.ndrHistory.length - 1]?.date,
        ).toDateString();
        const currentStatusDate = new Date(
          normalizedData.StatusDateTime,
        ).toDateString();

        if (
          lastEntryDate !== currentStatusDate ||
          order.ndrHistory.length === 0
        ) {
          const attemptCount = order.ndrHistory?.length + 1 || 0;
          if (SmartShipStatusMapping[instruction] === "Undelivered") {
            // process.exit(1)
            order.ndrHistory.push({
              date: normalizedData.StatusDateTime,
              action: "Auto Reattempt",
              remark: normalizedData.StrRemarks,
              attempt: attemptCount + 1,
            });
          }
        }
      }

      if (
        (order.status === "RTO" || order.status === "RTO In-transit") &&
        (instruction === "rto delivered to shipper" ||
          instruction === "rto delivered to fc")
      ) {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
      }
      if (
        instruction === "delivered" ||
        instruction === "delivery confirmed by customer"
      ) {
        order.status = "Delivered";
        // order.ndrStatus = "Delivered";
      }
    }
    if (provider === "Shree Maruti" || provider === "ShreeMaruti") {
      // console.log("ShreeMaruti normalizedData", normalizedData);
      if (normalizedData.ShipmentType === "forward") {
        if (
          normalizedData.Status === "ORDER_CONFIRMED" ||
          normalizedData.Status === "PICKUP_PENDING" ||
          normalizedData.Status === "READY_FOR_DISPATCH" ||
          normalizedData.Status === "NOT_PICKED_UP"
          // normalizedData.Status === "PICKUP_SCHEDULED"||
          // normalizedData.Status === "PICKUP_DONE"
        ) {
          order.status = "Ready To Ship";
        }

        if (normalizedData.Status === "IN_TRANSIT") {
          if (!order.invoiceDate) {
            order.invoiceDate = normalizedData.StatusDateTime;
          }
          order.status = "In-transit";
        }

        if (normalizedData.Status === "OUT_FOR_DELIVERY") {
          order.status = "Out for Delivery";
          order.ndrStatus = "Out for Delivery";
        }

        if (normalizedData.Status === "DELIVERED") {
          order.status = "Delivered";
        }

        if (normalizedData.Status === "LOST") {
          order.status = "Lost";
        }

        if (
          (order.ndrStatus === "Undelivered" ||
            order.ndrStatus === "Out for Delivery" ||
            order.ndrStatus === "Action_Requested") &&
          normalizedData.Instructions === "Delivered"
        ) {
          order.ndrStatus = "Delivered";
        }

        // Detect Delivery Attempted
        const secondLastTracking =
          Array.isArray(order.tracking) && order.tracking.length >= 2
            ? order.tracking[order.tracking.length - 2]
            : null;

        const wasPreviousDeliveryAttempted =
          secondLastTracking?.Instructions === "DeliveryAttempted";

        if (
          normalizedData.Instructions === "DeliveryAttempted" ||
          wasPreviousDeliveryAttempted
        ) {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          // updateNdrHistoryByAwb(order.awb_number);
          order.reattempt = true;
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.StrRemarks,
          };

          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];

          const lastEntryDate = lastAction?.date
            ? new Date(lastAction.date).toDateString()
            : null;

          const currentStatusDate = new Date(
            normalizedData.StatusDateTime,
          ).toDateString();

          if (
            (order.ndrHistory.length === 0 ||
              lastEntryDate !== currentStatusDate) &&
            order.ndrHistory.length <= 2
          ) {
            const attemptCount = order.ndrHistory?.length + 1 || 0;
            // Create a new NDR history entry with one action
            const newHistoryEntry = {
              actions: [
                {
                  action: `NDR ${attemptCount} Raised`,
                  actionBy: order.courierServiceName,
                  remark: normalizedData.StrRemarks,
                  source: order.provider,
                  date: normalizedData.StatusDateTime,
                },
              ],
            };

            order.ndrHistory.push(newHistoryEntry);
          }
        }
      } else {
        // RTO flow
        if (
          normalizedData.Status === "RTO_INITIATED" &&
          order.status === "Undelivered"
        ) {
          order.status = "RTO";
          order.ndrStatus = "RTO";
        }

        if (
          normalizedData.Instructions === "ArrivedAtCarrierFacility" ||
          normalizedData.Instructions === "Departed" ||
          normalizedData.Instructions ===
          "Package arrived at the carrier facility" ||
          normalizedData.Instructions ===
          "Package has left the carrier facility"
        ) {
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
        }

        if (normalizedData.Instructions === "ReturnInitiated") {
          order.status = "RTO In-transit";
        }

        if (normalizedData.Status === "RTO_DELIVERED") {
          order.status = "RTO Delivered";
          order.ndrStatus = "RTO Delivered";
        }
      }
    }
    if (provider === "Delhivery") {
      const statusDoc = await statusMap.findOne(
        { partnerName: provider.toUpperCase() }, // partnerName stored as uppercase
        { data: 1 },
      );
      // console.log("stat", normalizedData.StatusType, normalizedData.Status);
      if (statusDoc) {
        function normalizeString(str) {
          return str
            ?.toLowerCase()
            .replace(/['"]/g, "") // remove apostrophes and quotes
            .replace(/[^a-z0-9]/gi, "") // remove all non-alphanumeric characters
            .trim();
        }

        const dbMapping = statusDoc?.data.find(
          (d) =>
            normalizeString(d?.scan_type) ===
            normalizeString(normalizedData?.StatusType) &&
            normalizeString(d?.scan) ===
            normalizeString(normalizedData?.Status) &&
            normalizeString(d?.instructions) ===
            normalizeString(normalizedData?.Instructions),
        );

        if (dbMapping) {
          order.status = dbMapping.sy_status;
          order.ndrStatus = dbMapping.sy_status;

          if (dbMapping.sy_status === "In-transit" && !order.invoiceDate) {
            order.invoiceDate = normalizedData.StatusDateTime;
          }

          if (order.status === "RTO Delivered") order.ndrStatus = "RTO Delivered";

          if (["RTO", "RTO In-transit"].includes(order.status)) {
            order.ndrStatus = order.status;
          }
        }
      }

      if (normalizedData.Status === "Delivered") {
        if (order.ndrHistory.length > 0) {
          order.status = "Delivered";
          order.ndrStatus = "Delivered";
        } else {
          order.status = "Delivered";
        }
      }
      
      const eligibleNSLCodes = [
        "EOD-74",
        "EOD-15",
        "EOD-104",
        "EOD-43",
        "EOD-86",
        "EOD-11",
        "EOD-69",
        "EOD-6",
      ];

      const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
      const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];

      const lastEntryDate = lastAction?.date
        ? new Date(lastAction.date).getTime()
        : null;

      const currentStatusDate = new Date(
        normalizedData.StatusDateTime,
      ).getTime();

      if (
        (order.ndrHistory.length === 0 ||
          (lastEntryDate !== null && lastEntryDate < currentStatusDate))
      ) {
        if (
          normalizedData.StatusCode &&
          eligibleNSLCodes.includes(normalizedData.StatusCode)
        ) {
          order.ndrStatus = "Undelivered";
          order.status = "Undelivered";
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.Instructions,
          };
          const attemptCount = order.ndrHistory?.length + 1 || 0;
          // New structured entry
          const newHistoryEntry = {
            actions: [
              {
                action: `NDR ${attemptCount} Raised`,
                actionBy: order.provider,
                remark: normalizedData.Instructions,
                source: order.provider,
                date: normalizedData.StatusDateTime,
              },
            ],
          };

          order.ndrHistory.push(newHistoryEntry);
        }
      }
      order.reattempt = isReAttemptEligible(order, normalizedData);
    }
    if (partner === "ZipyPost") {
      const scanCode = normalizedData.scanCode;
      const instruction = normalizedData.Instructions?.toLowerCase();
      const statusText = normalizedData.Status?.toLowerCase();
      // console.log("ZipyPost scanCode", scanCode, instruction, statusText);
      // Map status using ZipyPostScanCodeMapping
      order.status = ZipyPostScanCodeMapping[scanCode];
      if (
        ZipyPostScanCodeMapping[scanCode] === "In-transit" &&
        !order.invoiceDate
      ) {
        order.invoiceDate = normalizedData.StatusDateTime;
      }
      // if (order.ndrStatus !== "Action_Requested") {
      //   order.ndrStatus = ZipyPostScanCodeMapping[scanCode];
      // }

      // --- Handle RTO logic ---
      if (order.status === "RTO" || order.status === "RTO In-transit") {
        order.ndrStatus = "RTO";
        order.reattempt = false;
      }

      if (
        normalizedData.scanCode === 9 ||
        normalizedData.Status === "RTO Delivered"
      ) {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
      }

      // --- Mark Delivered ---
      if (
        normalizedData.scanCode === 5 ||
        normalizedData.Status === "Delivered"
      ) {
        order.status = "Delivered";
        order.ndrStatus = "Delivered";
        order.reattempt = false;
      }

      // --- Handle Out for Delivery ---
      if (normalizedData.scanCode === 4) {
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
      }

      // --- Handle Undelivered / NDR Cases ---
      if (normalizedData.scanCode === 11) {
        if (order.ndrStatus !== "Action_Requested") {
          // updateNdrHistoryByAwb(order.awb_number);
          order.ndrStatus = "Undelivered";
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.Instructions,
          };

          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
          const lastEntryDate = lastAction?.date
            ? new Date(lastAction.date).getTime()
            : null;

          const currentStatusDate = new Date(
            normalizedData.StatusDateTime,
          ).getTime();
          // console.log("ZipyPost NDR lastEntryDate:", lastEntryDate, "currentStatusDate:", currentStatusDate);
          // Avoid duplicate same-day entries & limit history entries
          if (
            (order.ndrHistory.length === 0 ||
              lastEntryDate < currentStatusDate)
            // order.ndrHistory.length <= 3
          ) {
            // console.log("Adding NDR history entry for AWB:", order.awb_number);

            const attemptCount = order.ndrHistory?.length + 1 || 0;
            order.reattempt = true;
            const newHistoryEntry = {
              actions: [
                {
                  action: `NDR ${attemptCount} Raised`,
                  actionBy: order.courierServiceName,
                  remark: normalizedData.Instructions,
                  source: order.provider,
                  date: normalizedData.StatusDateTime,
                },
              ],
            };

            order.ndrHistory.push(newHistoryEntry);
          }
        }
      }

      if (order.ndrHistory.length >= 4) {
        order.reattempt = false;
      }

      // --- Cancelled Case ---
      if (normalizedData.scanCode === 6) {
        balanceTobeAdded =
          order.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(order.totalFreightCharges);
        shouldUpdateWallet = true;
        order.ndrStatus = "Cancelled";
        order.status = "Cancelled";
      }

      // console.log("ZipyPost normalizedData:", normalizedData);
    }

    if (partner === "Losung360") {
      // Use system_status_code (SPB, PKD, etc.) as the primary key — it's more reliable than text matching
      const statusCode = normalizedData.StatusCode?.toUpperCase() || "";

      // Matching based on exact system_status_code
      if (statusCode === "SPB") {
        order.status = "Ready To Ship";
        order.ndrStatus = "Ready To Ship";

      } else if (statusCode === "SPD" || statusCode === "OFP" || statusCode === "CTR") {
        order.status = "Booked";

      } else if (statusCode === "PKD" || statusCode === "INT" || statusCode === "DAC") {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        if (!order.invoiceDate) {
          order.invoiceDate = normalizedData.StatusDateTime;
        }
        order.reattempt = false;

      } else if (statusCode === "OFD") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;

      } else if (statusCode === "UND" || statusCode === "DEX") {
        order.status = "Undelivered";
        order.ndrStatus = "Undelivered";
        order.ndrReason = {
          date: normalizedData.StatusDateTime,
          reason: normalizedData.Instructions || "Delivery attempted/exception",
        };
        // order.reattempt = true;

        const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
        const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
        const lastEntryDate = lastAction?.date
          ? new Date(lastAction.date).getTime()
          : null;
        const currentStatusDate = new Date(normalizedData.StatusDateTime).getTime();

        if (
          order.ndrHistory.length === 0 ||
          lastEntryDate < currentStatusDate
        ) {
          const attemptCount = order.ndrHistory?.length + 1 || 0;
          const newHistoryEntry = {
            actions: [
              {
                action: `NDR ${attemptCount} Raised`,
                actionBy: order.provider,
                remark: normalizedData.Instructions || "Delivery attempted/exception",
                source: order.provider,
                date: normalizedData.StatusDateTime,
              },
            ],
          };
          order.ndrHistory.push(newHistoryEntry);
        }

      } else if (statusCode === "DEL") {
        order.status = "Delivered";
        order.ndrStatus = "Delivered";
        order.reattempt = false;

      } else if (statusCode === "RTD") {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;

      } else if (statusCode === "RTO" || statusCode === "RRA" || statusCode === "RUN") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;

      } else if (statusCode === "SC" || statusCode === "PCN" || statusCode === "ONH") {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        order.reattempt = false;
        balanceTobeAdded =
          order.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(order.totalFreightCharges);
        shouldUpdateWallet = true;

      } else if (statusCode === "LOS" || statusCode === "DMG" || statusCode === "CUN") {
        order.status = "Lost";
        order.reattempt = false;

      } else if (statusCode === "PKF" || statusCode === "ADI") {
        order.status = "Pickup Failed";
        order.reattempt = false;
      }
    }

    if (partner === "BoxdLogistics") {
      // normalizedData.Instructions = the raw `status` field from the API (snake_case)
      // e.g. 'shipped', 'pickup_scheduled', 'out_for_delivery', 'delivered', 'undelivered', 'rto', 'rto_delivered', 'cancelled'
      const statusCode = normalizedData.Instructions?.toLowerCase(); // e.g. "shipped"
      // console.log("status",normalizedData)
      // --- Pickup Scheduled / Ready To Ship ---
      if (
        statusCode === "pickup_scheduled" ||
        statusCode === "order_created" ||
        statusCode === "shipped"
      ) {
        order.status = "Ready To Ship";
      }

      // --- Shipped / In-transit ---
      if (
        statusCode === "in_transit" ||
        statusCode === "picked_up" ||
        statusCode === "dispatched"
      ) {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        if (!order.invoiceDate) {
          order.invoiceDate = normalizedData.StatusDateTime;
        }
        order.reattempt = false;
      }

      // --- Out for Delivery ---
      if (statusCode === "out_for_delivery") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
      }

      // --- Delivered ---
      if (statusCode === "delivered") {
        order.status = "Delivered";
        order.reattempt = false;
        if (
          order.ndrStatus === "Undelivered" ||
          order.ndrStatus === "Out for Delivery" ||
          order.ndrStatus === "Action_Requested"
        ) {
          order.ndrStatus = "Delivered";
        }
      }

      // --- Undelivered / NDR ---
      if (
        statusCode === "undelivered" ||
        statusCode === "delivery_failed" ||
        statusCode === "delivery_attempt_failed"
      ) {
        if (order.ndrStatus !== "Action_Requested") {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.Description || normalizedData.Instructions,
          };

          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
          const lastEntryDate = lastAction?.date
            ? new Date(lastAction.date).getTime()
            : null;
          const currentStatusDate = new Date(normalizedData.StatusDateTime).getTime();

          if (
            (order.ndrHistory.length === 0 || lastEntryDate < currentStatusDate)
            // order.ndrHistory.length <= 3
          ) {
            const attemptCount = order.ndrHistory?.length + 1 || 0;
            order.reattempt = true;
            const newHistoryEntry = {
              actions: [
                {
                  action: `NDR ${attemptCount} Raised`,
                  actionBy: order.courierServiceName,
                  remark: normalizedData.Description || normalizedData.Remarks || "Delivery Failed",
                  source: order.provider,
                  date: normalizedData.StatusDateTime,
                },
              ],
            };
            order.ndrHistory.push(newHistoryEntry);
          }
        }
      }

      if (order.ndrHistory.length >= 4) {
        order.reattempt = false;
      }

      // --- RTO ---
      if (statusCode === "rto" || statusCode === "rto_initiated") {
        order.status = "RTO";
        order.ndrStatus = "RTO";
        order.reattempt = false;
      }

      // --- RTO In-transit ---
      if (statusCode === "rto_in_transit" || statusCode === "rto_intransit") {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      // --- RTO Delivered ---
      if (statusCode === "rto_delivered") {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
      }

      // --- Cancelled ---
      if (statusCode === "cancelled" || statusCode === "shipment_cancelled") {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        balanceTobeAdded =
          order.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(order.totalFreightCharges);
        shouldUpdateWallet = true;
      }

    }


    if (partner === "Proship") {
      console.log("pro tracking", normalizedData);
      const statusCode = normalizedData.statusCode;
      const statusDescription = normalizedData.Status || "";
      const remark = normalizedData.Instructions || statusDescription;
      const timestamp = normalizedData.StatusDateTime;

      const RTO_STATUS_CODES = [11, 12, 13, 14, 15, 21, 26, 27, 101];
      const isRTO = RTO_STATUS_CODES.includes(statusCode);

      if (isRTO) {
        order.reattempt = false;
        if (statusCode === 11 || statusCode === 101 || statusCode === 12) {
          order.status = "RTO";
          order.ndrStatus = "RTO";
        } else if (statusCode === 14) {
          order.status = "RTO Delivered";
          order.ndrStatus = "RTO Delivered";
        } else {
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
        }
      } else {
        if ([1, 28, 33].includes(statusCode)) {
          order.status = "Booked";
        } else if ([25, 2].includes(statusCode)) {
          order.status = "Ready To Ship";
          order.ndrStatus = "Ready To Ship";
        }
        else if (statusCode === 3) {
          order.status = "Booked";
        } else if (statusCode === 4) {
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
          order.reattempt = false;
          if (!order.invoiceDate) order.invoiceDate = timestamp;
        } else if ([5, 18, 20, 19].includes(statusCode)) {
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
          order.reattempt = false;
        } else if (statusCode === 6) {
          order.status = "Out for Delivery";
          order.ndrStatus = "Out for Delivery";
          order.reattempt = false;
        } else if (statusCode === 7) {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
        } else if (statusCode === 8) {
          order.status = "Delivered";
          order.ndrStatus = order.ndrHistory.length > 0 ? "Delivered" : "";
          order.reattempt = order.ndrHistory.length > 0;
        } else if (statusCode === 10) {
          order.status = "Cancelled";
          order.ndrStatus = "Cancelled";
          balanceTobeAdded = order.totalFreightCharges === "N/A" ? 0 : parseFloat(order.totalFreightCharges);
          shouldUpdateWallet = true;
        } else if (statusCode === 16) {
          order.status = "Lost";
        } else if (statusCode === 9) {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          const currentDate = new Date(timestamp).getTime();
          let lastNdrDate = null;
          if (order.ndrHistory.length > 0) {
            const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
            const lastAction = lastHistory.actions[lastHistory.actions.length - 1];
            lastNdrDate = new Date(lastAction.date).getTime();
          }
          const attemptCount = order.ndrHistory.length + 1;
          order.ndrReason = { date: timestamp, reason: remark };

          if (!(order.ndrStatus === "Action_Requested" && lastNdrDate && currentDate <= lastNdrDate)) {
            if (!lastNdrDate || currentDate > lastNdrDate) {
              order.reattempt = true;
              order.ndrHistory.push({
                actions: [{
                  action: `NDR ${attemptCount} Raised`,
                  actionBy: order.provider || "Shadowfax",
                  remark: remark,
                  source: order.provider || "Shadowfax",
                  date: timestamp,
                }],
              });
            }
          }
        }
      }
    }


    // ── Shadowfax Status Handling ──────────────────────────────────────────────
    // Shadowfax tracking_details items: { status_id, status, remarks, created, location }
    // status_id values defined in the Shadowfax Unified API documentation.
    if (partner === "Shadowfax" || provider === "Shadowfax") {
      const sfxStatusId = normalizedData.Instructions?.toLowerCase() || ""; // status_id stored in Instructions

      // ── Forward journey ────────────────────────────────────────────────────
      if (sfxStatusId === "new" || sfxStatusId === "assigned_for_seller_pickup") {
        order.status = "Booked";
      }

      if (
        sfxStatusId === "ofp" ||
        sfxStatusId === "picked" ||
        sfxStatusId === "recd_at_rev_hub" ||
        sfxStatusId === "item_manifested" ||
        sfxStatusId === "received_from_client_warehouse"
      ) {
        order.status = "Ready To Ship";
      }

      if (
        sfxStatusId === "recd_at_fwd_hub" ||
        sfxStatusId === "recd_at_fwd_dc" ||
        sfxStatusId === "bag_in_transit" ||
        sfxStatusId === "bag_received" ||
        sfxStatusId === "bag_received_at_via" ||
        sfxStatusId === "in_transit"
      ) {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
        if (!order.invoiceDate) {
          order.invoiceDate = normalizedData.StatusDateTime;
        }
      }

      if (sfxStatusId === "assigned_for_delivery") {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
      }

      if (sfxStatusId === "ofd") {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
      }

      if (sfxStatusId === "delivered") {
        order.status = "Delivered";
        order.reattempt = false;
        if (
          order.ndrStatus === "Undelivered" ||
          order.ndrStatus === "Out for Delivery" ||
          order.ndrStatus === "Action_Requested"
        ) {
          order.ndrStatus = "Delivered";
        }
      }

      // ── NDR cases ────────────────────────────────────────────────────────
      if (
        sfxStatusId === "nc" ||   // Not Contactable
        sfxStatusId === "na" ||   // Not Attempted
        sfxStatusId === "cid"     // Customer Initiated Delay
      ) {
        if (order.ndrStatus !== "Action_Requested") {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.Status || sfxStatusId,
          };

          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
          const lastEntryDate = lastAction?.date
            ? new Date(lastAction.date).getTime()
            : null;
          const currentStatusDate = new Date(
            normalizedData.StatusDateTime
          ).getTime();

          if (
            order.ndrHistory.length === 0 ||
            !lastEntryDate ||
            currentStatusDate > lastEntryDate
          ) {
            const attemptCount = order.ndrHistory.length + 1;
            order.reattempt = true;
            order.ndrHistory.push({
              actions: [
                {
                  action: `NDR ${attemptCount} Raised`,
                  actionBy: order.courierServiceName || "Shadowfax",
                  remark: normalizedData.Status || sfxStatusId,
                  source: "Shadowfax",
                  date: normalizedData.StatusDateTime,
                },
              ],
            });
          }
        }
      }

      if (order.ndrHistory.length >= 4) {
        order.reattempt = false;
      }

      if (sfxStatusId === "reopen_ndr") {
        order.reattempt = true;
      }

      // ── RTO / RTS ────────────────────────────────────────────────────────
      if (
        sfxStatusId === "ots" ||
        sfxStatusId === "rts" ||
        sfxStatusId === "oto" ||
        sfxStatusId === "cancelled_by_customer" ||
        sfxStatusId === "seller_not_contactable"
      ) {
        order.status = "RTO";
        order.ndrStatus = "RTO";
        order.reattempt = false;
      }

      if (
        sfxStatusId === "rts_in_process" ||
        sfxStatusId === "in_transit_return" ||
        sfxStatusId === "oto_in_process" ||
        sfxStatusId === "rto_in_process"
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      if (
        sfxStatusId === "rts_ofd" ||
        sfxStatusId === "rto_ofd"
      ) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      }

      if (
        sfxStatusId === "rts_d" ||
        sfxStatusId === "rto_d"
      ) {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
      }

      // ── Lost ─────────────────────────────────────────────────────────────
      if (sfxStatusId === "lost") {
        order.status = "Lost";
        order.reattempt = false;
      }

      // ── Cancelled ────────────────────────────────────────────────────────
      if (sfxStatusId === "cancelled_by_seller") {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        order.reattempt = false;
        balanceTobeAdded =
          order.totalFreightCharges === "N/A"
            ? 0
            : parseFloat(order.totalFreightCharges);
        shouldUpdateWallet = true;
      }
    }


    // ── ShipRocket Status Handling ──────────────────────────────────────────
    if (partner === "Shiprocket") {

      // shipment_status numeric codes from ShipRocket API:
      // 1=Pending, 2=Confirmed, 3=Ready To Ship, 4=Picked Up, 5=In Transit
      // 6=Out for Delivery, 7=Undelivered, 8=Delivered, 9=Cancelled
      // 10=RTO Initiated, 11=RTO In Transit, 12=RTO Delivered, 13=Lost
      const statusCode = normalizedData.shipment_status;

      if ([1, 2, 3].includes(statusCode)) {
        order.status = "Ready To Ship";
        order.ndrStatus = "Ready To Ship";
      } else if (statusCode === 4 || statusCode === 5) {
        order.status = "In-transit";
        order.ndrStatus = "In-transit";
        order.reattempt = false;
        if (!order.invoiceDate) order.invoiceDate = normalizedData.StatusDateTime;
      } else if (statusCode === 6) {
        order.status = "Out for Delivery";
        order.ndrStatus = "Out for Delivery";
        order.reattempt = false;
      } else if (statusCode === 7) {
        if (order.ndrStatus !== "Action_Requested") {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          order.ndrReason = {
            date: normalizedData.StatusDateTime,
            reason: normalizedData.Instructions || "Delivery attempt failed",
          };

          const lastNdr = order.ndrHistory[order.ndrHistory.length - 1];
          const lastAction = lastNdr?.actions?.[lastNdr.actions.length - 1];
          const lastEntryDate = lastAction?.date
            ? new Date(lastAction.date).getTime()
            : null;
          const currentStatusDate = new Date(normalizedData.StatusDateTime).getTime();

          if (order.ndrHistory.length === 0 || !lastEntryDate || currentStatusDate > lastEntryDate) {
            const attemptCount = order.ndrHistory.length + 1;
            order.reattempt = true;
            order.ndrHistory.push({
              actions: [{
                action: `NDR ${attemptCount} Raised`,
                actionBy: order.courierServiceName || "Shiprocket",
                remark: normalizedData.Instructions || "Delivery Failed",
                source: "Shiprocket",
                date: normalizedData.StatusDateTime,
              }],
            });
          }
        }

        if (order.ndrHistory.length >= 4) order.reattempt = false;
      } else if (statusCode === 8) {
        order.status = "Delivered";
        order.reattempt = false;
        if (order.ndrHistory.length > 0) order.ndrStatus = "Delivered";
      } else if (statusCode === 9) {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        order.reattempt = false;
        balanceTobeAdded =
          order.totalFreightCharges === "N/A" ? 0 : parseFloat(order.totalFreightCharges);
        shouldUpdateWallet = true;
      } else if (statusCode === 10) {
        order.status = "RTO";
        order.ndrStatus = "RTO";
        order.reattempt = false;
      } else if (statusCode === 11) {
        order.status = "RTO In-transit";
        order.ndrStatus = "RTO In-transit";
        order.reattempt = false;
      } else if (statusCode === 12) {
        order.status = "RTO Delivered";
        order.ndrStatus = "RTO Delivered";
        order.reattempt = false;
      } else if (statusCode === 13) {
        order.status = "Lost";
        order.reattempt = false;
      }
    }

    // ── Ekart Status Handling ──────────────────────────────────────────────────
    if (partner === "Ekart" || provider === "Ekart") {
      const currentStatus = normalizedData.Status;
      const descLower = (normalizedData.Instructions || "").toLowerCase().trim();

      if (descLower.includes("mark_not_received")) {
        order.status = "Cancelled";
        order.ndrStatus = "Cancelled";
        order.reattempt = false;
        balanceTobeAdded = order.totalFreightCharges === "N/A" || !order.totalFreightCharges
          ? 0
          : parseFloat(order.totalFreightCharges);
        shouldUpdateWallet = true;
      } else {
        const isReadyToShipDesc = descLower.includes("dispached by quickpost") || descLower.includes("consignment manifested");

        if (isReadyToShipDesc) {
          order.status = "Ready To Ship";
          order.ndrStatus = "Ready To Ship";
          order.reattempt = false;
        } else if (currentStatus === "Picked Up") {
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
          if (!order.invoiceDate) {
            order.invoiceDate = normalizedData.StatusDateTime;
          }
          order.reattempt = false;
        }

        if (currentStatus === "In Transit" || currentStatus === "Reached Hub") {
          order.status = "In-transit";
          order.ndrStatus = "In-transit";
          order.reattempt = false;
        }

        if (currentStatus === "Out for Delivery") {
          order.status = "Out for Delivery";
          order.ndrStatus = "Out for Delivery";
          order.reattempt = false;
        }

        if (currentStatus === "Delivered" || descLower.includes("delivered to")) {
          order.status = "Delivered";

          if (order.ndrHistory.length > 0) {
            order.ndrStatus = "Delivered";
            order.reattempt = false;
          } else {
            order.ndrStatus = "";
            order.reattempt = false;
          }
        }

        if (currentStatus === "RTO" || currentStatus === "RTO Requested") {
          order.status = "RTO";
          order.ndrStatus = "RTO";
          order.reattempt = false;
        }

        if (currentStatus === "RTO In Transit") {
          order.status = "RTO In-transit";
          order.ndrStatus = "RTO In-transit";
          order.reattempt = false;
        }

        if (currentStatus === "RTO Delivered") {
          order.status = "RTO Delivered";
          order.ndrStatus = "RTO Delivered";
          order.reattempt = false;
        }

        const EKART_NDR_STATUSES = [
          "Unknown Exception",
          "Customer Unavailable",
          "Rejected by Customer",
          "Delivery Rescheduled",
          "Pickup Rescheduled",
          "Customer Unreachable",
          "Address Issue",
          "Payment Issue",
          "Out Of Delivery Area",
          "Order Already Cancelled",
          "Self Collect",
          "Shipment Seized By Customer",
          "Dispute",
          "Maximum Attempt Reached",
          "Not Attempted",
          "OTP Not Received/OTP Mismatch",
          "OTP Verified Cancellation",
          "On Hold",
          "RTO Delivery Failed"
        ];
        const normalizedNdrStatuses = EKART_NDR_STATUSES.map(s => s.toLowerCase().trim());
        const isEligibleForNdr = currentStatus && normalizedNdrStatuses.includes(currentStatus.toLowerCase().trim());

        if (isEligibleForNdr && currentStatus !== "RTO In Transit") {
          order.status = "Undelivered";
          order.ndrStatus = "Undelivered";
          order.reattempt = false;

          const ndrDate = normalizedData.StatusDateTime || new Date();
          const ndrReasonText = normalizedData.Instructions || normalizedData.StrRemarks || currentStatus || "";
          const currentDate = ndrDate instanceof Date ? ndrDate.getTime() : new Date(ndrDate).getTime();

          let lastNdrDate = null;
          if (order.ndrHistory.length > 0) {
            const lastHistory = order.ndrHistory[order.ndrHistory.length - 1];
            const lastAction = lastHistory.actions[lastHistory.actions.length - 1];
            lastNdrDate = new Date(lastAction.date).getTime();
          }

          const attemptCount = order.ndrHistory.length + 1;

          order.ndrReason = {
            date: ndrDate,
            reason: ndrReasonText,
          };

          if (
            !(
              order.ndrStatus === "Action_Requested" &&
              lastNdrDate &&
              currentDate <= lastNdrDate
            )
          ) {
            if (!lastNdrDate || currentDate > lastNdrDate) {
              order.reattempt = true;
              order.ndrHistory.push({
                actions: [
                  {
                    action: `NDR ${attemptCount} Raised`,
                    actionBy: order.provider || "Ekart",
                    remark: ndrReasonText,
                    source: order.provider || "Ekart",
                    date: ndrDate,
                  },
                ],
              });
            }
          }
        }
      }
    }

    const scansArray = (partner === "Losung360" || provider === "Losung360")
      ? (result.data?.history || [])
      : (Array.isArray(result.data) ? result.data : []);

    if (scansArray.length > 0) {
      // If API returned a full list of tracking events
      const newTrackingArray = scansArray.map((item) => {
        const mapped =
          partner === "ZipyPost" || partner === "BoxdLogistics" || partner === "Proship" || partner === "Shiprocket" || partner === "Ekart" || partner === "Losung360"
            ? mapTrackingResponse([item], partner)
            : mapTrackingResponse([item], provider, result?.remark);

        return {
          status: mapped?.Status || "N/A",
          StatusLocation: mapped?.StatusLocation || "Unknown",
          StatusDateTime: mapped?.StatusDateTime || null,
          Instructions: mapped?.Instructions || "N/A",
        };
      });

      // Compare last tracking event with previous one
      const newLast = newTrackingArray[newTrackingArray.length - 1];
      const oldLast = order.tracking?.[order.tracking.length - 1];

      // Check if both last events are same
      const isSameAsPrevious =
        oldLast &&
        newLast &&
        oldLast.Instructions === newLast.Instructions &&
        new Date(oldLast.StatusDateTime).getTime() ===
        new Date(newLast.StatusDateTime).getTime();

      // if (isSameAsPrevious) {
      //   console.log(
      //     `🟡 Skipping ${order.awb_number} — tracking unchanged (same Instructions & StatusDateTime)`
      //   );
      //   return; // 🔥 skip further processing and DB writes
      // }

      // Replace entire tracking array, preserving the starting 2 statuses
      const startingTracking = (order.tracking && order.tracking.length > 0) ? order.tracking.slice(0, 2) : [];
      order.tracking = [...startingTracking, ...newTrackingArray];
      await order.save();
      console.log(`Tracking history replaced for ${order.awb_number} (preserving initial stages)`);

      // 🔹 Trigger Notifications are now handled automatically by the Order model hook (post-save)
      // No manual calls needed here.

      // 🔹 Sync status back to WooCommerce if this is a WooCommerce order
      if (order.channel === "WooCommerce") {
        (async () => {
          try {
            const AllChannelModel = require("../Channels/allChannel.model");
            const store = await AllChannelModel.findOne({ userId: order.userId, channel: "WooCommerce" });
            if (store?.storeURL) {
              await markWooOrderAsShipped(
                store.storeURL,
                order.orderId,      // internal Shipex orderId
                order.awb_number,
                order.provider,     // courier provider name
                order.status
              );
            } else {
              console.warn(`⚠️ No WooCommerce store found for userId: ${order.userId}`);
            }
          } catch (e) {
            console.error(`⚠️ WooCommerce status sync failed for AWB ${order.awb_number}:`, e.message);
          }
        })();
      }

      console.log("saved");
    }

    // Wallet update logic (moved outside array check to handle single object responses)
    if (shouldUpdateWallet && balanceTobeAdded > 0) {
      // Step 0: Check if same awb_number already exists twice
      const existingCount = await WalletTransaction.countDocuments({
        walletId: currentWallet._id,
        awb_number: order.awb_number || "",
      });

      if (existingCount >= 2) {
        console.log(
          `Skipping wallet update for AWB: ${order.awb_number}, already logged twice.`,
        );
        return; // Exit if already present twice
      }

      // Step 1: Update balance
      await Wallet.updateOne(
        { _id: currentWallet._id },
        { $inc: { balance: balanceTobeAdded } },
      );

      // Step 2: Get updated wallet balance
      const updatedWallet = await Wallet.findById(currentWallet._id).select("balance");

      // Step 3: Create the transaction
      await WalletTransaction.create({
        walletId: currentWallet._id,
        channelOrderId: order.orderId || null,
        category: "credit",
        amount: balanceTobeAdded,
        balanceAfterTransaction: updatedWallet.balance,
        date: new Date(),
        awb_number: order.awb_number || "",
        description: "Freight Charges Received",
      }).catch(err => console.error("⚠️ WalletTransaction create failed in tracking controller:", err.message));

      console.log(
        "Wallet updated for AWB:",
        order.awb_number,
        "Amount:",
        balanceTobeAdded,
      );
    }
  } catch (error) {
    console.error(
      `Error tracking order ID: ${order._id}, AWB: ${order.awb_number} ${error}`,
    );
  }
};

// Main controller
const trackOrders = async (includeWebhooks = false) => {
  try {
    const pLimit = await import("p-limit").then((mod) => mod.default);
    const limit = pLimit(10); // Max 10 concurrent executions

    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000); // For urgent updates
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000); // For general updates fallback
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000); // Only track webhook orders from last 15 days

    const webhookNames = [
      "Shree Maruti", "ShreeMaruti",
      "Dtdc", "DTDC",
      "Delhivery",
      "Ekart",
      "Amazon", "Amazon Shipping",
      "Shiprocket",
      "Shadowfax",
      "Proship",
      // "Losung360"
    ];

    let query = {};

    if (includeWebhooks) {
      query = {
        $or: [
          {
            provider: { $nin: webhookNames },
            partner: { $nin: webhookNames },
            status: { $nin: ["new", "Cancelled", "Delivered", "RTO Delivered"] },
          },
          {
            $or: [
              { provider: { $in: webhookNames } },
              { partner: { $in: webhookNames } },
            ],
            status: { $in: ["Out for Delivery", "Undelivered", "Action_Requested"] },
            createdAt: { $gte: fifteenDaysAgo },
          },
        ],
        $and: [
          {
            $or: [
              { lastTrackedAt: { $exists: false } },
              { lastTrackedAt: null },
              {
                $and: [
                  { status: "Out for Delivery" },
                  { lastTrackedAt: { $lt: twoHoursAgo } },
                ],
              },
              {
                $and: [
                  { status: { $ne: "Out for Delivery" } },
                  { lastTrackedAt: { $lt: threeHoursAgo } },
                ],
              },
            ],
          },
        ],
      };
    } else {
      query = {
        status: { $nin: ["new", "Cancelled", "Delivered", "RTO Delivered"] },
        provider: { $nin: webhookNames },
        partner: { $nin: webhookNames },
        $or: [
          { lastTrackedAt: { $exists: false } },
          { lastTrackedAt: null },
          {
            $and: [
              { status: "Out for Delivery" },
              { lastTrackedAt: { $lt: twoHoursAgo } },
            ],
          },
          {
            $and: [
              { status: { $ne: "Out for Delivery" } },
              { lastTrackedAt: { $lt: threeHoursAgo } },
            ],
          },
        ],
      };
    }

    // Find orders that are due for tracking (polling as a fallback to webhooks)
    const allOrders = await Order.find(query);

    console.log(`📦 Found ${allOrders.length} orders to track (includeWebhooks: ${includeWebhooks})`);

    // Bulk update lastTrackedAt for the whole batch to avoid redundant polling
    if (allOrders.length > 0) {
      const orderIds = allOrders.map((o) => o._id);
      await Order.updateMany(
        { _id: { $in: orderIds } },
        { $set: { lastTrackedAt: new Date() } }
      );
    }

    const limitedTrack = limiter.wrap(trackSingleOrder); // apply rate limiter

    const trackingPromises = allOrders.map(
      (order) => limit(() => limitedTrack(order)), // limit concurrency
    );

    await Promise.all(trackingPromises);

    console.log("✅ All tracking updates completed");
  } catch (error) {
    console.error("❌ Error in tracking orders:", error);
  }
};
// trackOrders()

// Optimized Background Task: Scheduled tracking loop using node-cron
// This is more scalable and cost-effective for AWS than setTimeout polling.
if (process.env.NODE_ENV === "production") {
  console.log("📅 Order Tracking Scheduled: Hourly check for due orders");
  // Run every hour during active business hours (6 AM to 10 PM IST)
  cron.schedule("0 6-22 * * *", async () => {
    console.log("🕒 Starting scheduled Order Tracking...");
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      hour: "numeric",
      hour12: false
    });
    const currentHour = parseInt(formatter.format(new Date()), 10);
    const includeWebhooks = currentHour === 22;
    console.log(`[Cron Run] Current hour in IST: ${currentHour}. Include webhooks: ${includeWebhooks}`);
    await trackOrders(includeWebhooks);
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata"
  });
}

const mapTrackingResponse = (data, provider, remark) => {
  // console.log("Mapping data for provider:", data);
  if (provider === "Losung360") {
    const rawData = data[0] || {};
    
    const formatLosung360DateTime = (rawDate) => {
      if (!rawDate) return null;
      if (typeof rawDate !== "string") return new Date(rawDate);
      if (rawDate.includes("Z") || rawDate.includes("+")) return new Date(rawDate);
      
      const parts = rawDate.split(/[\s\-:]+/);
      if (parts.length >= 5) {
        const day = parts[0].padStart(2, "0");
        const monthName = parts[1].toLowerCase().slice(0, 3);
        const year = parts[2];
        const hour = parts[3].padStart(2, "0");
        const minute = parts[4].padStart(2, "0");
        const second = (parts[5] || "00").padStart(2, "0");
        
        const months = {
          jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
          jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
        };
        const month = months[monthName];
        if (month) {
          const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
          const parsedDate = new Date(isoString);
          if (!isNaN(parsedDate.getTime())) {
            return parsedDate;
          }
        }
      }
      
      const formatted = rawDate.replace(" ", "T") + "Z"; // treat the IST time as-is so frontend shows correct time
      const parsed = new Date(formatted);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
      return new Date(rawDate);
    };

    let history = [];
    if (Array.isArray(rawData.history)) {
      history = [...rawData.history];
      history.sort((a, b) => {
        const dateA = formatLosung360DateTime(a.timestamp) || new Date(0);
        const dateB = formatLosung360DateTime(b.timestamp) || new Date(0);
        return dateA - dateB;
      });
      rawData.history = history; // mutate original array so caller uses sorted history
    }

    const latestScan = history.length > 0 ? history[history.length - 1] : rawData;

    return {
      Status: latestScan?.system_status_name || latestScan?.status || rawData.current_status || "N/A",
      StatusCode: latestScan?.system_status_code || null,   // e.g. "SPB", "PKD"
      StatusLocation: latestScan?.location || "Unknown",
      StatusDateTime: formatLosung360DateTime(latestScan?.timestamp),
      Instructions: latestScan?.description || latestScan?.status || rawData.current_status || "N/A",
    };
  }
  if (provider === "Ekart") {
    const event = data[0];
    const formatEkartDateTime = (ctime) => {
      if (!ctime) return null;
      if (!isNaN(ctime)) {
        const timestamp = Number(ctime);
        const ms = timestamp < 9999999999 ? timestamp * 1000 : timestamp;
        return new Date(ms + 5.5 * 60 * 60 * 1000);
      }
      return new Date(ctime);
    };

    return {
      Status: event?.status || event?.Status || "N/A",
      StatusLocation: event?.location || event?.StatusLocation || "Unknown",
      StatusDateTime: formatEkartDateTime(event?.ctime || event?.StatusDateTime),
      Instructions: event?.desc || event?.Instructions || "N/A",
    };
  }
  if (provider === "Smartship") {
    // console.log("Smartship data", data);
    const scans = data?.scans;
    const orderId = Object.keys(scans || {})[0]; // only one AWB per call
    const scanArray = scans?.[orderId];
    const latestScan = data;
    // console.log("latestScan", latestScan);
    return {
      Status: latestScan?.status_description || "N/A",
      StrRemarks: latestScan?.status_description || "N/A",
      StatusLocation: latestScan?.location || "Unknown",
      StatusDateTime: formatSmartShipDateTime(latestScan?.date_time) || null,
      Instructions: latestScan?.action || "N/A",
    };
  }
  if (provider === "Shree Maruti" || provider === "ShreeMaruti") {
    // console.log("ShreeMaruti data", data);
    const last = data[0];
    // console.log("ShreeMaruti last", last);
    return {
      Status: last?.category || null,
      StatusLocation: last?.location || "Unknown",
      StatusDateTime: last?.createdAt
        ? formatShreeMarutiDate(last.createdAt)
        : null,
      Instructions: last?.subcategory || null,
      ShipmentType: last?.movement_type || null,
    };
  }

  if (provider === "ZipyPost") {
    // console.log("ZipyPost data", data);
    const scanArray = data || []; // array of scans
    const latestScan = scanArray?.[0]; // take the most recent scan
    // console.log("last", scanArray[0]);
    return {
      Status: latestScan?.scan || "N/A",
      scanCode: latestScan?.scan_code ?? null,
      // StrRemarks: latestScan?.remark || "N/A",
      StatusLocation: latestScan?.location || "Unknown",
      StatusDateTime: latestScan?.scan_time || null,
      Instructions: latestScan?.remark || "N/A",
    };
  }

  if (provider === "BoxdLogistics") {
    // Real API response: { id, shipment_id, awb_number, status, description, remarks, location, datetime, created_at, ... }
    // Dates from API are naive IST strings like '2026-03-07T16:42:19.578337' (no timezone suffix)
    // Append 'Z' directly so the frontend reads it as-is (same pattern as ShreeMaruti in this codebase)
    // e.g. '2026-03-07T16:42:19.578337Z' → frontend displays 4:42 PM correctly
    const formatBoxdDateTime = (rawDate) => {
      if (!rawDate) return null;
      if (rawDate.includes("Z") || rawDate.includes("+")) return rawDate;
      return rawDate + "Z"; // treat the IST time as-is so frontend shows correct time
    };

    const scanArray = Array.isArray(data[0]) ? data[0] : (Array.isArray(data) ? data : []);
    // console.log("scan",scanArray)
    const latestScan = scanArray?.[scanArray.length - 1];
    return {
      Status: latestScan?.status || "N/A",          // e.g. 'shipped', 'pickup_scheduled'
      Description: latestScan?.description || "N/A", // human-readable description
      scanCode: latestScan?.status ?? null,           // use status string as code
      StatusLocation: latestScan?.location || "Unknown",
      StatusDateTime: formatBoxdDateTime(latestScan?.datetime || latestScan?.created_at),
      Instructions: latestScan?.status || "N/A",     // used for status-matching logic
      Remarks: latestScan?.remarks || null,
    };
  }

  // ── Shadowfax ──────────────────────────────────────────────────────────────
  // Shadowfax tracking_details items: { status_id, status, remarks, created, location, awb_number }
  if (provider === "Shadowfax") {
    const scanArray = data || [];
    const latestScan = scanArray[scanArray.length - 1];
    return {
      Status: latestScan?.status || "N/A",                // Human-readable status e.g. "Delivered"
      Instructions: latestScan?.status_id || "N/A",       // Machine-readable status_id e.g. "delivered"
      StatusLocation: latestScan?.location || "Unknown",
      StatusDateTime: latestScan?.created || null,
      StrRemarks: latestScan?.remarks || latestScan?.status || "N/A",
    };
  }

  if (provider === "Proship") {

    const scanArray = data || [];
    const latestScan = scanArray?.[scanArray.length - 1];

    // Proship timestamps are UTC — shift to IST (+5:30) before saving
    const toIST = (utcStr) => {
      if (!utcStr) return null;
      const d = new Date(utcStr);
      d.setTime(d.getTime() + 5.5 * 60 * 60 * 1000); // +5h 30m
      return d;
    };

    // Remove the word "proship" from anywhere in the text (case-insensitive)
    const cleanProshipText = (str) => {
      if (!str) return str;
      return str
        .replace(/\s*[-\u2013]\s*proship/gi, "")  // " - proship"
        .replace(/proship\s*[-\u2013]\s*/gi, "")  // "proship - "
        .replace(/\bon\s+proship\b/gi, "")         // "on proship"
        .replace(/\bproship\b/gi, "")              // any remaining word
        .replace(/\s{2,}/g, " ")                   // collapse extra spaces
        .replace(/[\s\-\u2013]+$/, "")             // trailing separators
        .trim();
    };

    return {
      Status: cleanProshipText(latestScan?.orderStatusDescription || String(latestScan?.orderStatusCode) || "N/A"),
      StatusLocation: latestScan?.currentLocation || "Unknown",
      StatusDateTime: toIST(latestScan?.timestamp),
      Instructions: cleanProshipText(latestScan?.remark || latestScan?.orderStatusDescription || "N/A"),
      statusCode: latestScan?.orderStatusCode || null,
    };
  }

  // console.log(data, provider);
  const providerMappings = {
    EcomExpress: {
      Status: data.rts_system_delivery_status || "N/A",
      StatusLocation: data.current_location_name || "N/A",
      StatusDateTime: data.last_update_datetime || null,
      Instructions: data.tracking_status || null,
      ReasonCode: data.reason_code_description || null,
    },

    Dtdc: {
      Status: data ? data[0].strCode : "N/A",
      StrRemarks: data ? data[0].sTrRemarks : "N/A",
      StatusLocation: data ? data[0].strOrigin : "N/A",
      StatusDateTime: data
        ? formatDTDCDateTime(data[0]?.strActionDate, data[0]?.strActionTime)
        : null,
      Instructions: data ? data[0].strAction : "N/A",
    },

    DTDC: {
      Status: data ? data[0].strCode : "N/A",
      StrRemarks: data ? data[0].sTrRemarks : "N/A",
      StatusLocation: data ? data[0].strOrigin : "N/A",
      StatusDateTime: data
        ? formatDTDCDateTime(data[0]?.strActionDate, data[0]?.strActionTime)
        : null,
      Instructions: data ? data[0].strAction : "N/A",
    },

    "Amazon Shipping": {
      Status: data[0].eventCode || "N/A",
      StrRemarks: remark,
      StatusLocation: data[0]?.location?.city,
      StatusDateTime: data ? formatAmazonDate(data[0]?.eventTime) : "N/A",
      Instructions: data ? data[0]?.eventCode : "N/A",
      ShipmentType: data ? data[0]?.shipmentType : "N/A",
    },

    Amazon: {
      Status: data[0].eventCode || "N/A",
      StrRemarks: remark,
      StatusLocation: data[0]?.location?.city,
      StatusDateTime: data ? formatAmazonDate(data[0]?.eventTime) : "N/A",
      Instructions: data ? data[0]?.eventCode : "N/A",
      ShipmentType: data ? data[0]?.shipmentType : "N/A",
    },

    Shiprocket: {
      Status: data[0]?.current_status || null,
      StatusLocation: data[0]?.location || "Unknown",
      StatusDateTime: data[0]?.timestamp ? new Date(data[0].timestamp) : null,
      Instructions: data[0]?.instructions || null,
      shipment_status: data[0]?.shipment_status || null,
    },
    NimbusPost: {
      Status: data.status || null,
      StatusCode: data.status_code || null,
      StatusLocation: data.city || "Unknown",
      StatusDateTime: data.updated_on || null,
      Instructions: data.remarks || null,
    },
    Delhivery: {
      Status: data[0].Scan || "N/A",
      StatusType: data[0].ScanType || "N/A",
      StatusCode: data[0].StatusCode || null,
      StatusLocation: data[0].ScannedLocation || "Unknown",
      StatusDateTime: data[0].ScanDateTime || null,
      Instructions: data[0].Instructions || null,
    },
    Xpressbees: {
      Status: data.tracking_status || null,
      StatusCode: data.status_code || null,
      StatusLocation: data.location || "Unknown",
      StatusDateTime: data.last_update || null,
      Instructions: data.remarks || null,
    },
  };

  return providerMappings[provider] || null;
};

const formatDTDCDateTime = (dateStr, timeStr) => {
  if (!dateStr || dateStr.length !== 8) {
    return null; // Handle invalid inputs
  }

  try {
    // Extract date components
    const day = parseInt(dateStr.slice(0, 2));
    const month = parseInt(dateStr.slice(2, 4)) - 1; // JavaScript months are 0-based
    const year = parseInt(dateStr.slice(4, 8));

    // Extract time components
    const hours = parseInt(timeStr.slice(0, 2));
    const minutes = parseInt(timeStr.slice(2, 4));

    // Construct local (IST) date
    const date = new Date(year, month, day, hours, minutes);

    return date; // This will be in local system time (typically IST on Indian servers)
  } catch (err) {
    console.warn(`Invalid DTDC date/time format: ${dateStr} ${timeStr}`);
    return null;
  }
};

const formatAmazonDate = (isoDateStr) => {
  try {
    const d = new Date(isoDateStr);
    return d.toISOString(); // already UTC, just standardize
  } catch (err) {
    // console.warn("Invalid Amazon date:", isoDateStr);
    return null;
  }
};

const formatSmartShipDateTime = (dateTimeStr) => {
  if (!dateTimeStr || typeof dateTimeStr !== "string") return null;

  try {
    // Input: "29-07-2025 23:01:06"
    const [datePart, timePart] = dateTimeStr.trim().split(" ");
    const [day, month, year] = datePart.split("-").map(Number);
    const [hours, minutes, seconds] = timePart.split(":").map(Number);

    // Create a Date in UTC directly using Date.UTC
    const utcDate = new Date(
      Date.UTC(year, month - 1, day, hours, minutes, seconds),
    );

    // Return ISO string without shifting (i.e., time stays 23:01:06)
    return utcDate.toISOString();
  } catch (err) {
    console.warn("Invalid SmartShip date format:", dateTimeStr);
    return null;
  }
};

const formatShreeMarutiDate = (isoDateStr) => {
  try {
    const date = new Date(isoDateStr);

    // Convert to IST first
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;

    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const second = get("second");
    const millis = get("fractionalSecond") || "000";

    // ⚡️ Store IST time but with Z (UTC), so frontend shift works
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
  } catch (err) {
    console.warn("Invalid date:", isoDateStr);
    return null;
  }
};

const updateNdrHistoryByAwb = async (awb_number) => {
  try {
    const order = await Order.findOne({ awb_number });

    if (!order) {
      console.log(`❌ Order not found for AWB: ${awb_number}`);
      return;
    }

    // Get provider and corresponding status mapping
    const provider = order.provider?.toLowerCase();
    let statusMapping;

    switch (provider) {
      case "dtdc":
        statusMapping = DTDCStatusMapping;
        break;
      case "delhivery":
        statusMapping = DelhiveryStatusMapping;
        break;
      case "amazon":
        statusMapping = AmazonStatusMapping;
        break;
      case "smartship":
        statusMapping = SmartShipStatusMapping;
        break;
      default:
        console.log(
          `⚠️ No status mapping found for provider: ${order.provider}`,
        );
        return;
    }

    const initialLength = order.ndrHistory.reduce(
      (sum, group) => sum + (group.actions?.length || 0),
      0,
    );

    const statusKeys = Object.keys(statusMapping).map((s) => s.toLowerCase());

    // Go through groups and remove actions that match a statusKey
    const filteredNdrHistory = order.ndrHistory
      .map((group) => {
        const filteredActions = (group.actions || []).filter(
          (action) => !statusKeys.includes(action.remark?.toLowerCase()),
        );
        return { ...group, actions: filteredActions };
      })
      .filter((group) => group.actions.length > 0); // remove empty groups

    const finalLength = filteredNdrHistory.reduce(
      (sum, group) => sum + (group.actions?.length || 0),
      0,
    );

    if (finalLength < initialLength) {
      await Order.findOneAndUpdate(
        { awb_number },
        { $set: { ndrHistory: filteredNdrHistory } },
        { new: true },
      );

      console.log(
        `✅ Updated order ${awb_number} — Removed ${initialLength - finalLength
        } NDR entries`,
      );
    } else {
      console.log(
        `ℹ️ No matching NDR remarks to remove for order ${awb_number}`,
      );
    }
  } catch (error) {
    console.error("❌ Error updating order by AWB:", error);
  }
};

function isReAttemptEligible(order, normalizedData) {
  const eligibleNSL = [
    "EOD-74",
    "EOD-15",
    "EOD-104",
    "EOD-43",
    "EOD-86",
    "EOD-11",
    "EOD-69",
    "EOD-6",
  ];

  // 1. Check NSL eligibility
  if (
    !normalizedData.StatusCode ||
    !eligibleNSL.includes(normalizedData.StatusCode)
  ) {
    return false;
  }

  // 2. Check attempt count (should be 1 or 2)
  const attempts = order.ndrHistory?.length || 0;
  if (attempts >= 2) {
    return false;
  }

  // 3. Check time from normalizedData.StatusDateTime
  if (!normalizedData.StatusDateTime) return false;

  const scanDate = new Date(normalizedData.StatusDateTime);
  const scanHour = scanDate.getHours();

  // Must be after 9 PM
  if (scanHour < 21) {
    return false;
  }

  // 4. Status must be Undelivered
  const isUndelivered =
    normalizedData.Status === "Undelivered" ||
    normalizedData.Instructions?.toLowerCase()?.includes("undelivered");

  if (!isUndelivered) return false;

  return true;
}

// updateNdrHistoryByAwb("362413842319");

module.exports = {
  trackSingleOrder,
  formatShreeMarutiDate,
  updateNdrHistoryByAwb,
  formatAmazonDate,
  formatDTDCDateTime,
  isReAttemptEligible,
};
