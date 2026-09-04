const Order = require("../models/newOrder.model");
const {
  callShiprocketNdrApi,
  callNimbustNdrApi,
  callEcomExpressNdrApi,
  callSmartshipNdrApi,
  handleDelhiveryNdrAction,
  submitNdrToDtdc,
  submitNdrToAmazon,
  submitNdrToZipypost,
  submitNdrToShreeMaruti,
  submitNdrToEkart,
  submitNdrToBoxdLogistics,
  submitNdrToProship,
  submitNdrToShipexIndia,
  submitNdrToJiffy,
} = require("../services/ndrService");


/**
 * Executes an NDR action for a specific order.
 * This is used by controllers and background cron jobs.
 */
const runNdrTask = async (orderId, actionDetails) => {
  try {
    const order = await Order.findById(orderId);
    if (!order) {
      return { success: false, message: "Order not found" };
    }

    const {
      action,
      remarks,
      comments,
      scheduledDate,
      scheduled_delivery_date,
      deliverySlot,
      phone,
      customer_name,
      address1,
      address2,
      city,
      state,
      pincode,
      partner,
      provider,
      platform,
    } = actionDetails;

    const finalRemarks = remarks || comments || "NDR Action Requested";
    const finalDate = scheduledDate || scheduled_delivery_date;
    const finalAwb = order.awb_number;
    const finalProvider = order.provider;
    const finalPartner = order.partner;
    const finalPlatform = order.platform;

    let apiResponse;

    if (finalPlatform === "shiprocket") {
      apiResponse = await callShiprocketNdrApi(order);
    } else if (finalPlatform === "nimbust") {
      apiResponse = await callNimbustNdrApi(order);
    } else if (finalProvider === "EcomExpress") {
      apiResponse = await callEcomExpressNdrApi(
        finalAwb,
        action,
        finalRemarks,
        finalDate,
        deliverySlot,
        phone,
        {
          CA1: address1,
          CA2: city + (state ? `, ${state}` : ""),
          CA3: address2 || "",
          CA4: customer_name,
        }
      );
    } else if (finalProvider === "Delhivery") {
      apiResponse = await handleDelhiveryNdrAction(finalAwb, action, finalRemarks);
    } else if (finalProvider === "Dtdc") {
      apiResponse = await submitNdrToDtdc(
        finalAwb,
        order.orderId,
        action,
        finalRemarks
      );
    } else if (finalProvider === "Amazon Shipping") {
      apiResponse = await submitNdrToAmazon(
        finalAwb,
        action,
        finalRemarks,
        finalDate
      );
    } else if (finalProvider === "Smartship") {
      apiResponse = await callSmartshipNdrApi(
        finalAwb,
        action,
        finalRemarks,
        finalDate,
        phone
      );
    } else if (finalProvider === "Shree Maruti") {
      apiResponse = await submitNdrToShreeMaruti({
        awb_number: finalAwb,
        actionType: action,
        remarks: finalRemarks,
        consignee_address: address1,
        phone,
      });
    } else if (finalProvider === "Ekart") {
      apiResponse = await submitNdrToEkart({
        awb_number: finalAwb,
        action,
        comments: finalRemarks,
        new_address: address1,
        new_address2: address2,
        customer_name,
        new_phone: phone,
        new_pincode: pincode,
        scheduled_delivery_date: finalDate,
      });
    } else if (finalPartner === "ZipyPost") {
      const customAction =
        action === "RE-ATTEMPT"
          ? "Re-Attempt"
          : action === "CHANGE CONTACT"
            ? "Change Contact"
            : action === "CHANGE ADDRESS"
              ? "Change Address"
              : action;
      apiResponse = await submitNdrToZipypost(finalAwb, {
        action: customAction,
        seller_remark: finalRemarks,
        contact_number: phone,
        customer_name,
        address1,
        address2,
        provider: finalProvider,
      });
    } else if (finalPartner === "BoxdLogistics") {
      apiResponse = await submitNdrToBoxdLogistics({
        awb_number: finalAwb,
        action,
        remarks: finalRemarks,
        action_date: null,
        updated_address_line1: address1,
        updated_address_line2: address2,
        updated_city: city || null,
        updated_state: state || null,
        updated_pincode: pincode || null,
        updated_mobile: phone,
      });
    } else if (finalPartner === "Proship") {
      apiResponse = await submitNdrToProship({
        awb_number: finalAwb,
        action,
        remarks: finalRemarks,
        customer_name,
        new_address: address1,
        new_address2: address2,
        new_phone: phone,
        new_pincode: pincode,
        scheduled_delivery_date: finalDate,
      });
    } else if (finalPartner === "ShipexIndia" || finalProvider === "ShipexIndia") {
      apiResponse = await submitNdrToShipexIndia({
        awb_number: finalAwb,
        action,
        comments: finalRemarks,
        scheduled_delivery_date: finalDate,
        phone,
      });
    } else if (finalPartner === "Jiffy") {
      apiResponse = await submitNdrToJiffy({
        awb_number: finalAwb,
        action,
        remarks: finalRemarks,
      });
    } else {

      apiResponse = { success: false, message: "Unsupported provider" };
    }

    return apiResponse;
  } catch (error) {
    console.error("Task Runner Error:", error);
    return { success: false, message: error.message || "Internal error" };
  }
};

module.exports = { runNdrTask };
