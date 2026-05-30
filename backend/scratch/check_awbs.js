const mongoose = require("mongoose");
require("dotenv").config();
const connection = require("../config/database");

async function run() {
  await connection();
  console.log("Connected database name:", mongoose.connection.db.databaseName);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
