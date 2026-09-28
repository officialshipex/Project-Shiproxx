// Once a parcel has actually been picked up, a "cancelled" signal coming from
// the courier must NOT cancel the order.
//
// Why: couriers emit cancellation-flavoured scans mid-journey that do not mean
// the shipment stopped — Delhivery's "EOD-6O Pending - Code verified
// cancellation" and "EOD-6 Consignee refused to accept/order cancelled" were
// both seen live on parcels that kept moving for days afterwards. Acting on
// them marked 28 live shipments as Cancelled and refunded the seller's freight
// while the courier carried on and, in at least one case, delivered the parcel
// and collected the COD. A cancellation that lands BEFORE pickup is still
// honoured — that one is real.
const POST_PICKUP_STATUSES = new Set([
  "In-transit",
  "Out for Delivery",
  "Delivered",
  "Undelivered",
  "Action_Requested",
  "RTO",
  "RTO In-transit",
  "RTO Delivered",
  "RTO Lost",
  "RTO Damaged",
  "Lost",
  "Damaged",
]);

// Pre-pickup states where a courier cancellation is legitimate and should
// still go through: new, Booked, Ready To Ship, Not Picked, processing.
const hasLeftOrigin = (status) => POST_PICKUP_STATUSES.has(String(status || "").trim());

module.exports = { hasLeftOrigin, POST_PICKUP_STATUSES };
