const Order = require("../models/newOrder.model");
const {
  getServiceablePincodesData,
} = require("../AllCouriers/NimbusPost/Couriers/couriers.controller");
const {
  checkServiceabilityShipRocket,
} = require("../AllCouriers/ShipRocket/Courier/couriers.controller");
const {
  checkServiceabilityXpressBees,
} = require("../AllCouriers/Xpressbees/MainServices/mainServices.controller");
const {
  checkPincodeServiceabilityDelhivery,
} = require("../AllCouriers/Delhivery/Courier/couriers.controller");
const {
  checkServiceabilityShreeMaruti,
} = require("../AllCouriers/ShreeMaruti/Couriers/couriers.controller");
const {
  checkServiceabilityEcomExpress,
} = require("../AllCouriers/EcomExpress/Couriers/couriers.controllers");
const {
  checkAmazonServiceability,
} = require("../AllCouriers/Amazon/Courier/couriers.controller");
const {
  checkServiceabilityDTDC,
} = require("../AllCouriers/DTDC/Courier/couriers.controller");
const {
  checkSmartshipHubServiceability,
} = require("../AllCouriers/SmartShip/Couriers/couriers.controller");
const {
  checkEkartServiceability,
} = require("../AllCouriers/Ekart/Couriers/couriers.controller");
const {
  checkVamashipServiceability,
} = require("../AllCouriers/Vamaship/Couriers/couriers.controller");
const {
  checkPincodeServiceability,
} = require("../checkPincodeServiceability/checkPincodeServiceability.controller");
const {
  checkZipypostServiceability,
} = require("../AllCouriers/Zipypost/Couriers/couriers.controller");
const {
  checkServiceabilityBoxdLogistics,
} = require("../AllCouriers/BoxdLogistics/Courier/couriers.controller");
const {
  checkProshipServiceability,
} = require("../AllCouriers/Proship/Courier/couriers.controller");
const {
  checkPincodeServiceability: checkShadowfaxServiceability,
} = require("../AllCouriers/Shadowfax/Courier/couriers.controller");
const {
  checkShipexIndiaServiceability,
} = require("../AllCouriers/ShipxIndia/Courier/couriers.controller");

const checkServiceabilityAll = async (service, id, pincode) => {
  try {
    const currentOrder = await Order.findById(id);
    if (!currentOrder) throw new Error("Order not found");
    // console.log("service",service)
    const pickupPincode = pincode;
    const deliveryPincode = currentOrder.receiverAddress?.pinCode || "";
    const paymentMethod = currentOrder.paymentDetails?.method || "prepaid";
    const weight = (currentOrder.packageDetails?.applicableWeight || 0) * 1000;
    // console.log("service",service)
    // Function to safely check local serviceability
    const checkLocalServiceability = async () => {
      try {
        const result = await checkPincodeServiceability(
          pickupPincode,
          service.provider,
          deliveryPincode,
          paymentMethod,
        );
        // console.log(`Local serviceability for ${service.provider}:`, result);
        return result;
      } catch (err) {
        console.error(
          `Local pincode check failed for ${service.provider}:`,
          err.message,
        );
        return false;
      }
    };
    // console.log("Checking serviceability for", service.provider);
    // ----------------------- NimbusPost -----------------------
    if (service.provider === "NimbusPostt") {
      const local = await checkLocalServiceability();
      if (local) return local;

      const payload = {
        origin: pickupPincode,
        destination: deliveryPincode,
        payment_type: paymentMethod === "COD" ? "cod" : "prepaid",
        order_amount: currentOrder.paymentDetails?.amount || 0,
        weight: weight,
        length: currentOrder.packageDetails.volumetricWeight?.length || 0,
        breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
        height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      };
      return await getServiceablePincodesData(service.courier, payload);
    }

    // ----------------------- XpressBees -----------------------
    if (service.provider === "Xpressbeett") {
      const local = await checkLocalServiceability();
      if (local) return local;

      const payload = {
        origin: pickupPincode,
        destination: deliveryPincode,
        payment_type: paymentMethod === "COD" ? "cod" : "prepaid",
        order_amount: currentOrder.paymentDetails?.amount || 0,
        weight: weight,
        length: currentOrder.packageDetails.volumetricWeight?.length || 0,
        breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
        height: currentOrder.packageDetails.volumetricWeight?.height || 0,
      };
      return await checkServiceabilityXpressBees(service.courier, payload);
    }

    // ----------------------- Amazon Shipping -----------------------
    if (service.provider === "Amazon Shipping") {
      // console.log("Checking Amazon Serviceability",service.provider);
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        orderId: currentOrder.orderId,
        origin: currentOrder.pickupAddress,
        destination: currentOrder.receiverAddress,
        payment_type: paymentMethod,
        order_amount: currentOrder.paymentDetails?.amount || 0,
        weight: weight,
        length: currentOrder.packageDetails.volumetricWeight?.length || 0,
        breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
        height: currentOrder.packageDetails.volumetricWeight?.height || 0,
        productDetails: currentOrder.productDetails,
      };
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const result = await checkAmazonServiceability(
          service.provider,
          payload,
        );
        // console.log("result", result);
        return result;
      }
    }

    // ----------------------- Delhivery -----------------------
    if (service.provider === "Delhivery") {
      // const local = await checkLocalServiceability();
      // if (local.success) return local;
      // if (local.reason === "courier_not_found" || local.reason === "error") {
      const result = await checkPincodeServiceabilityDelhivery(
        pickupPincode,
        deliveryPincode,
        paymentMethod === "COD" ? "cod" : "prepaid",
      );
      return result;
      // }
    }

    // ----------------------- Shree Maruti -----------------------
    if (service.provider === "Shree Maruti") {
      // console.log("servi",service.provider)
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        fromPincode: parseInt(pickupPincode),
        toPincode: parseInt(deliveryPincode),
        isCodOrder: paymentMethod === "COD",
        deliveryMode: "SURFACE",
      };
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const result = await checkServiceabilityShreeMaruti(payload);
        return result;
      }
    }

    // ----------------------- Ecom Express -----------------------
    if (service.provider === "EcomExpresss") {
      const local = await checkLocalServiceability();
      if (local.success) return local;
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const result = await checkServiceabilityEcomExpress(
          pickupPincode,
          deliveryPincode,
        );
        return result;
      }
    }

    // ----------------------- DTDC -----------------------
    if (service.provider === "Dtdc") {
      const local = await checkLocalServiceability();
      // console.log("Local DTDC Serviceability:", local);
      if (local.success) return local;
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const result = await checkServiceabilityDTDC(
          pickupPincode,
          deliveryPincode,
          paymentMethod,
        );
        // console.log("result",result)
        return result;
      }
    }

    // ----------------------- Smartship -----------------------
    if (service.provider === "Smartship") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        source_pincode: pickupPincode,
        destination_pincode: deliveryPincode,
        order_weight: weight,
        order_value: currentOrder.paymentDetails?.amount || 0,
      };
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const result = await checkSmartshipHubServiceability(payload);
        return result;
      }
    }

    // ----------------------- Ekart -----------------------
    if (service.provider === "Ekart") {
      const local = await checkLocalServiceability();
      if (local.success) return local;
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const payload = {
          pickUpPincode: pickupPincode,
          deliveryPincode: deliveryPincode,
          paymentMethod,
          codAmount: currentOrder.paymentDetails?.amount || 0,
          courierName: service.name,
        };
        const result = await checkEkartServiceability(payload);
        // console.log("result",result)
        return result;
      }
    }

    // ----------------------- Vamaship -----------------------
    if (service.provider === "Vamaship") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        source_pincode: pickupPincode,
        destination_pincode: deliveryPincode,
        payment_type: paymentMethod,
      };
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const result = await checkVamashipServiceability(payload);
        return result;
      }
    }
    if (service.provider === "ZipyPost") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        source_pincode: pickupPincode,
        destination_pincode: deliveryPincode,
        payment_type: currentOrder.paymentDetails?.method,
        order_weight: weight,
        length: currentOrder.packageDetails.volumetricWeight?.length || 0,
        breadth: currentOrder.packageDetails.volumetricWeight?.width || 0,
        height: currentOrder.packageDetails.volumetricWeight?.height || 0,
        order_value: currentOrder.paymentDetails?.amount || 0,
      };
      if (local.reason === "courier_not_found" || local.reason === "error") {
        const result = await checkZipypostServiceability(payload);
        return result;
      }
    }
    if (service.provider.toLowerCase() === "boxdlogistics") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        pickupPincode: pickupPincode,
        shippingPincode: deliveryPincode,
        paymentMode: paymentMethod === "COD" ? "cod" : "prepaid",
        codAmount: paymentMethod === "COD" ? (currentOrder.paymentDetails?.amount || 0) : 0,
        weight: weight,
        length: currentOrder.packageDetails.volumetricWeight?.length || 10,
        breadth: currentOrder.packageDetails.volumetricWeight?.width || 10,
        height: currentOrder.packageDetails.volumetricWeight?.height || 10,
      };
      const res = await checkServiceabilityBoxdLogistics(payload);

      if (res && res.success && Array.isArray(res.courier_ids)) {
        // Which courier_id this service maps to is whatever was set on it in
        // the "Add Courier Service" admin screen — not guessed from its
        // display name, which silently misclassified any "Flat 2kg" service
        // (courier_id 7) as courier_id 47 (only "Flat 0.5kg" is 47) here.
        const requiredCid = parseInt(service.courier_id);
        return { ...res, success: !isNaN(requiredCid) && res.courier_ids.includes(requiredCid) };
      }
      return res;
    }
    if (service.provider.toLowerCase() === "proship") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        pickUpPincode: pickupPincode,
        deliveryPincode: deliveryPincode,
      };
      const result = await checkProshipServiceability(payload);

      if (result && result.success && result.couriers) {
        const sName = service.name.toLowerCase();
        if (sName.includes("shadowfax")) {
          return { ...result, success: !!result.couriers.shadowfax };
        } else if (sName.includes("dtdc")) {
          return { ...result, success: !!result.couriers.dtdc };
        }
      }
      return result;
    }
    if (service.provider.toLowerCase() === "shiprocket") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        serviceName: service.name,
        origin: pickupPincode,
        destination: deliveryPincode,
        payment_type: paymentMethod === "COD",
        weight: currentOrder.packageDetails?.applicableWeight || 0,
      };
      return await checkServiceabilityShipRocket(payload);
    }
    if (service.provider.toLowerCase() === "shadowfax") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      return await checkShadowfaxServiceability(deliveryPincode, service.provider);
    }
    if (service.provider.toLowerCase() === "shipexindia") {
      const local = await checkLocalServiceability();
      if (local.success) return local;

      const payload = {
        pickUpPincode: pickupPincode,
        deliveryPincode: deliveryPincode,
        applicableWeight: currentOrder.packageDetails?.applicableWeight || 0.5,
        length: currentOrder.packageDetails.volumetricWeight?.length || 10,
        width: currentOrder.packageDetails.volumetricWeight?.width || 10,
        height: currentOrder.packageDetails.volumetricWeight?.height || 10,
        paymentType: paymentMethod,
        declaredValue: currentOrder.paymentDetails?.amount || 0,
      };
      const res = await checkShipexIndiaServiceability(payload);
      if (res && res.success && Array.isArray(res.data)) {
        let shipexCourierName = service.name;
        try {
          const CourierService = require("../models/CourierService.Schema");
          const serviceDoc = await CourierService.findOne({ name: service.name, provider: "ShipexIndia" });
          if (serviceDoc) {
            shipexCourierName = serviceDoc.courier || serviceDoc.name;
          }
        } catch (dbErr) {
          console.error("Error fetching CourierService details from DB:", dbErr.message);
        }

        const matchedCourier = res.data.find(
          (item) =>
            item.courierServiceName &&
            item.courierServiceName.toLowerCase().replace(/\s+/g, "") ===
              shipexCourierName.toLowerCase().replace(/\s+/g, "")
        );
        if (matchedCourier && matchedCourier.serviceable === true) {
          return { ...res, success: true };
        }
      }
      return false;
    }
    if (service.provider.toLowerCase() === "losung360") {

      return { success: true };
    }

    // Default
    return false;
  } catch (error) {
    console.error("Error in checking serviceability:", error.message);
    return false;
  }
};

module.exports = { checkServiceabilityAll };
