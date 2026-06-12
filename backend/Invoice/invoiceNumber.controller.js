const InvoiceCounter = require("./invoiceCounter.model");

function getFinancialYear(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  // FY starts in April
  if (month >= 4) {
    return `${String(year).slice(2)}${String(year + 1).slice(2)}`;
  } else {
    return `${String(year - 1).slice(2)}${String(year).slice(2)}`;
  }
}

async function generateInvoiceNumber(date = new Date()) {
  const prefix = date >= new Date(2026, 8, 1) ? "QPS" : "SFC";
  const fy = getFinancialYear(date); // e.g. "2324"
  const key = `${prefix}${fy}`;

  const counter = await InvoiceCounter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  const paddedSeq = String(counter.seq).padStart(7, "0");
  return `${key}-${paddedSeq}`;
}

module.exports = {
  generateInvoiceNumber,
};
