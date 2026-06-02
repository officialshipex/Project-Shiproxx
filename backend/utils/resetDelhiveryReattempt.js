require("dotenv").config();
const mongoose = require("mongoose");
const Order = require("../models/newOrder.model");

const resetDelhiveryReattempt = async () => {
  try {
    const orders = await Order.find({
      provider: "Delhivery",
      status: "Undelivered",
      reattempt: true,
    });

    for (const order of orders) {
      order.reattempt = false;
      await order.save();
    }

    console.log(`Reset reattempt for ${orders.length} Delhivery orders`);
    return { success: true, count: orders.length };
  } catch (error) {
    console.error("Error resetting Delhivery reattempt:", error);
    return { success: false, error: error.message };
  }
};

if (require.main === module) {
  mongoose.connect(process.env.MONGODB_URI).then(async () => {
    console.log("✅ Database connected");
    await resetDelhiveryReattempt();
    await mongoose.connection.close();
    process.exit(0);
  }).catch((err) => {
    console.error("❌ DB connection error:", err);
    process.exit(1);
  });
}

module.exports = { resetDelhiveryReattempt };
