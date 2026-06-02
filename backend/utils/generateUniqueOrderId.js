const Order = require("../models/newOrder.model");

/**
 * Generates unique numeric order IDs.
 * Starts at 6 digits (100000 - 999999).
 * If the 6-digit space is completely exhausted, dynamically scales to 7 digits, etc.
 * Uses optimized batching queries for bulk orders to minimize database roundtrips.
 *
 * @param {number} countNeeded - Number of unique IDs to generate (defaults to 1)
 * @returns {Promise<number | number[]>} - Returns a single number if countNeeded is 1, or an array of numbers if countNeeded > 1
 */
async function generateUniqueOrderIds(countNeeded = 1) {
  if (countNeeded <= 0) return [];

  // Fast path: single ID — just pick a random 6-digit and verify
  if (countNeeded === 1) {
    const min = 100000, max = 999999;
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = Math.floor(min + Math.random() * 900000);
      const exists = await Order.findOne({ orderId: candidate }).select("_id").lean();
      if (!exists) return candidate;
    }
    // Fall through to full logic if 50 attempts fail
  }

  let d = 6;
  const uniqueIds = new Set();

  while (uniqueIds.size < countNeeded) {
    const min = Math.pow(10, d - 1); // e.g., 100000 for d=6
    const max = Math.pow(10, d) - 1;  // e.g., 999999 for d=6
    const totalCombinations = 9 * Math.pow(10, d - 1); // e.g., 900000 for d=6

    // 1. Check if the current digit space is fully exhausted
    const count = await Order.countDocuments({ orderId: { $gte: min, $lte: max } });

    if (count >= totalCombinations) {
      // 6-digit space is fully exhausted, advance to 7 digits
      d++;
      continue;
    }

    const remainingNeeded = countNeeded - uniqueIds.size;

    // 2. High saturation mitigation: if > 90% full, do an index-based check or sequential walk
    // to avoid infinite random collision checking loops.
    if (count > totalCombinations * 0.9) {
      // Find all existing orderIds in this range
      const existingOrders = await Order.find({ orderId: { $gte: min, $lte: max } })
        .select("orderId")
        .lean();
      
      const existingSet = new Set(existingOrders.map(o => o.orderId));

      // Sequential scan starting from a random index to avoid sequential bias
      let startIdx = min + Math.floor(Math.random() * totalCombinations);
      for (let offset = 0; offset < totalCombinations; offset++) {
        const candidate = min + ((startIdx - min + offset) % totalCombinations);
        if (!existingSet.has(candidate) && !uniqueIds.has(candidate)) {
          uniqueIds.add(candidate);
          if (uniqueIds.size === countNeeded) break;
        }
      }

      // If we still could not fulfill the requested count, it means the space got filled 
      // in the meantime (concurrency). Increment digit length.
      if (uniqueIds.size < countNeeded) {
        d++;
      }
    } else {
      // 3. Normal / Low saturation: Generate random candidate IDs and batch-check them
      const batchSize = Math.max(remainingNeeded * 2, 10);
      const candidates = new Set();

      while (candidates.size < batchSize) {
        const num = Math.floor(min + Math.random() * totalCombinations);
        if (!uniqueIds.has(num)) {
          candidates.add(num);
        }
      }

      const candidateList = Array.from(candidates);

      // Perform a single batch lookup to check which candidate IDs already exist in the DB
      const matchedOrders = await Order.find({ orderId: { $in: candidateList } })
        .select("orderId")
        .lean();
      
      const matchedSet = new Set(matchedOrders.map(o => o.orderId));

      // Filter out candidates that already exist in the DB
      for (const candidate of candidateList) {
        if (!matchedSet.has(candidate)) {
          uniqueIds.add(candidate);
          if (uniqueIds.size === countNeeded) break;
        }
      }
    }
  }

  const result = Array.from(uniqueIds);
  return countNeeded === 1 ? result[0] : result;
}

module.exports = {
  generateUniqueOrderIds
};
