const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");
const { PDFDocument: PDFLibDocument } = require("pdf-lib");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { uploads, s3 } = require("../config/s3");
const cron = require("node-cron");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const ExcelJS = require("exceljs");
const moment = require("moment");
const Pan = require("../models/Pan.model");

const Wallet = require("../models/wallet"); // adjust path
const WalletTransaction = require("../models/WalletTransaction.model");
const Order = require("../models/newOrder.model"); // adjust path
const Invoice = require("./invoice.model"); // adjust path
const InvoiceCounter = require("./invoiceCounter.model");
const User = require("../models/User.model"); // adjust path
const GSTIN = require("../models/Gstin.model");
const billing = require("../models/billingInfo.model");
const { generateInvoiceNumber } = require("./invoiceNumber.controller");
const GST_RATE = 0.18;

// Prefer transaction.awb_number, fallback to regex on description
function extractAwbFromTransaction(txn) {
  if (!txn) return null;
  if (txn.awb_number && String(txn.awb_number).trim() !== "")
    return String(txn.awb_number).trim();

  const desc = String(txn.description || "");
  // Try common AWB patterns: numbers of length >=6, or with prefixes
  // e.g. "AWB: 35973710025970", "AWB#35973710025970", "awb 35973710025970"
  const awbRegex =
    /(?:AWB[:#\s-]*|awb[:#\s-]*|awb_number[:#\s-]*|awb no[:#\s-]*|awb#[:#\s-]*|awb-)([A-Za-z0-9-]{6,})/i;
  let m = desc.match(awbRegex);
  if (m && m[1]) return m[1];

  // fallback: find first long numeric token (>=6 digits)
  const numFallback = desc.match(/\b(\d{6,})\b/);
  if (numFallback) return numFallback[1];

  return null;
}

function allowedDescription(desc = "") {
  if (!desc) return false;
  const normalized = desc.trim().toLowerCase();
  const allowed = [
    "freight charges applied",
    "rto freight charges applied",
    "auto-accepted weight dispute charge",
    "weight dispute charges applied",
    "gst charges applied",
  ];
  return allowed.includes(normalized);
}

// PDF generation with clean layout and AWB table
async function generateInvoicePDF(invoice, company = {}, customer = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const fileName = `invoice-${invoice.invoiceNumber}.pdf`;
      const outPath = path.join(
        process.env.INVOICE_LOCAL_TMP || "/tmp",
        fileName,
      );

      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      // ================= OUTER INVOICE BORDER =================
      doc
        .rect(
          20, // left
          20, // top
          doc.page.width - 40, // width
          doc.page.height - 40, // height
        )
        .lineWidth(1)
        .stroke();

      /* ================= LOGO (TOP LEFT) ================= */

      const logoPath = path.join(__dirname, "../public/assets/Shipex.jpg");
      const logoWidth = 90;
      const logoHeight = 40;
      const logoX = 40;
      const logoY = 40;

      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, logoX, logoY, { width: logoWidth });
      }

      /* ================= HEADER ================= */

      // 🔑 EVERYTHING starts AFTER logo
      const contentStartY = logoY + logoHeight + 10;

      /* -------- COMPANY DETAILS (LEFT) -------- */

      doc
        .fontSize(14)
        .font("Helvetica-Bold")
        .text(company.name || "Company", 40, contentStartY);

      doc.moveDown(0.4);
      doc.fontSize(9).lineGap(4);

      if (company.address) {
        doc.font("Helvetica").text(company.address, {
          width: 300,
        });
      }

      if (company.phone) {
        doc.font("Helvetica-Bold").text("Phone:", { continued: true });
        doc.font("Helvetica").text(` ${company.phone}`);
      }

      if (company.email) {
        doc.font("Helvetica-Bold").text("Email:", { continued: true });
        doc.font("Helvetica").text(` ${company.email}`);
      }

      if (company.gstin) {
        doc.font("Helvetica-Bold").text("GSTIN:", { continued: true });
        doc.font("Helvetica").text(` ${company.gstin}`);
      }

      doc.lineGap(0);

      /* -------- INVOICE META (RIGHT) -------- */

      doc
        .fontSize(14)
        .font("Helvetica-Bold")
        .text("TAX INVOICE", 400, contentStartY, { align: "right" });

      const status = invoice.status || "PENDING";
      const statusColor = status === "PAID" ? "green" : "red";

      doc
        .fontSize(10)
        .fillColor(statusColor)
        .text(status, 400, contentStartY + 20, { align: "right" });

      doc.fillColor("black");

      const invoiceDate = new Date(invoice.periodEnd);
      const invoicePeriod = invoiceDate.toLocaleString("en-IN", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });

      doc
        .fontSize(9)
        .text(`Invoice No: ${invoice.invoiceNumber}`, 400, contentStartY + 40, {
          align: "right",
        })
        .text(
          `Invoice Date: ${invoiceDate.toLocaleDateString("en-IN", { timeZone: "UTC" })}`,
          400,
          contentStartY + 55,
          { align: "right" },
        )
        .text(`Invoice Period: ${invoicePeriod}`, 400, contentStartY + 70, {
          align: "right",
        });

      /* ================= HEADER SEPARATOR ================= */

      const headerEndY = doc.y + 15;
      doc.moveTo(40, headerEndY).lineTo(550, headerEndY).stroke();
      doc.y = headerEndY + 5;

      /* ================= BILL TO (TWO COLUMN) ================= */

      doc.fontSize(10).font("Helvetica-Bold").text("Bill To", 40);
      doc.moveDown(0.8);

      const leftX = 40;
      const rightX = 340;
      const colWidth = 260;
      const billStartY = doc.y;

      doc.fontSize(9).lineGap(4);

      /* ---------- LEFT COLUMN ---------- */

      doc
        .font("Helvetica-Bold")
        .text(customer.name || "N/A", leftX, billStartY, {
          width: colWidth,
        });

      doc.font("Helvetica").text(customer.address || "N/A", leftX, doc.y, {
        width: colWidth,
      });

      doc
        .font("Helvetica-Bold")
        .text("State:", leftX, doc.y, { continued: true });
      doc.font("Helvetica").text(` ${customer.state || "N/A"}`);

      doc
        .font("Helvetica-Bold")
        .text("Pincode:", leftX, doc.y, { continued: true });
      doc.font("Helvetica").text(` ${customer.pincode || "N/A"}`);

      /* ---------- RIGHT COLUMN ---------- */

      doc.y = billStartY;

      doc
        .font("Helvetica-Bold")
        .text("PAN:", rightX, doc.y, { continued: true });
      doc.font("Helvetica").text(` ${customer.pan || "N/A"}`);

      doc
        .font("Helvetica-Bold")
        .text("GSTIN:", rightX, doc.y, { continued: true });
      doc.font("Helvetica").text(` ${customer.gstin || "N/A"}`);

      doc
        .font("Helvetica-Bold")
        .text("Reverse Charge:", rightX, doc.y, { continued: true });
      doc.font("Helvetica").text(" No");

      /* ---------- MOVE BELOW BILL TO ---------- */
      doc.y = Math.max(doc.y, billStartY) + 12;
      doc.lineGap(0);

      doc.moveDown(2);

      /* ================= FREIGHT TABLE (WITH BORDERS) ================= */

      const tableX = 40;
      const tableWidth = 510; // 550 - 40
      const descColWidth = 350;
      const amtColWidth = tableWidth - descColWidth;

      const rowHeight = 24;
      let tableY = doc.y;

      /* ---- TABLE HEADER ---- */

      doc.fontSize(9).font("Helvetica-Bold");

      doc.rect(tableX, tableY, tableWidth, rowHeight).stroke();

      doc.text("Description", tableX + 8, tableY + 7, {
        width: descColWidth - 10,
      });

      doc.text("Total", tableX + descColWidth + 8, tableY + 7, {
        width: amtColWidth - 10,
      });

      // Vertical divider
      doc
        .moveTo(tableX + descColWidth, tableY)
        .lineTo(tableX + descColWidth, tableY + rowHeight)
        .stroke();

      tableY += rowHeight;

      /* ---- ROW: FREIGHT ---- */

      doc.font("Helvetica");

      doc.rect(tableX, tableY, tableWidth, rowHeight).stroke();

      doc.text("Freight Charges", tableX + 8, tableY + 7, {
        width: descColWidth - 10,
      });

      doc.text(
        Number(invoice.taxableValue || 0).toFixed(2),
        tableX + descColWidth + 8,
        tableY + 7,
        {
          width: amtColWidth - 10,
        },
      );

      // Vertical divider
      doc
        .moveTo(tableX + descColWidth, tableY)
        .lineTo(tableX + descColWidth, tableY + rowHeight)
        .stroke();

      tableY += rowHeight;

      /* ---- ROW: GST ---- */

      doc.rect(tableX, tableY, tableWidth, rowHeight).stroke();

      doc.text("GST @18%", tableX + 8, tableY + 7, {
        width: descColWidth - 10,
      });

      doc.text(
        Number(invoice.tax || 0).toFixed(2),
        tableX + descColWidth + 8,
        tableY + 7,
        {
          width: amtColWidth - 10,
        },
      );

      // Vertical divider
      doc
        .moveTo(tableX + descColWidth, tableY)
        .lineTo(tableX + descColWidth, tableY + rowHeight)
        .stroke();

      tableY += rowHeight;

      /* ---- ROW: GRAND TOTAL ---- */

      doc.font("Helvetica-Bold");

      doc.rect(tableX, tableY, tableWidth, rowHeight).stroke();

      doc.text("Grand Total", tableX + 8, tableY + 7, {
        width: descColWidth - 10,
      });

      doc
        .fillColor(status === "PAID" ? "green" : "black")
        .text(
          Number(invoice.tax + invoice.taxableValue || 0).toFixed(2),
          tableX + descColWidth + 8,
          tableY + 7,
          {
            width: amtColWidth - 10,
          },
        );

      doc.fillColor("black");

      /* ---- MOVE CURSOR BELOW TABLE ---- */

      doc.y = tableY + rowHeight + 15;

      /* ================= PAYMENT DETAILS ================= */

      if (invoice.paymentHistory?.length) {
        // 🔑 HARD RESET CURSOR
        const paymentStartX = 40;
        let paymentStartY = doc.y + 10;

        doc.x = paymentStartX;
        doc.y = paymentStartY;

        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .text("Payment Details", paymentStartX, paymentStartY);

        doc.moveDown(0.6);

        const px = {
          date: 40,
          mode: 150,
          txn: 260,
          amt: 520,
        };

        let py = doc.y;

        // Table Header
        doc.fontSize(9).font("Helvetica-Bold");
        doc.text("Date", px.date, py);
        doc.text("Mode", px.mode, py);
        doc.text("Txn ID", px.txn, py);
        doc.text("Amount (₹)", px.amt, py, { align: "right" });

        doc
          .moveTo(40, py + 14)
          .lineTo(550, py + 14)
          .stroke();

        py += 22;

        // Rows
        doc.font("Helvetica");
        invoice.paymentHistory.forEach((p) => {
          doc.text(new Date(p.date).toLocaleDateString(), px.date, py);
          doc.text(p.paymentMode || "-", px.mode, py);
          doc.text(p.transactionId || "-", px.txn, py);

          doc
            .fillColor(p.status)
            .text(Number(p.amount || 0).toFixed(2), px.amt, py, {
              align: "right",
            });

          doc.fillColor("black");
          py += 16;
        });

        // 🔑 Move cursor below payment table
        doc.y = py + 10;
      }

      /* ================= BANK & COMMERCIAL DETAILS ================= */

      doc.moveDown(1);
      doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke("black");
      doc.moveDown(1);

      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .text("Bank & Commercial Details", 40);
      doc.moveDown(0.6);

      doc.fontSize(9).lineGap(4);

      doc.font("Helvetica-Bold").text("Account Name:", { continued: true });
      doc.font("Helvetica").text(` ${company.bank?.accountName || "N/A"}`);

      doc.font("Helvetica-Bold").text("Account Number:", { continued: true });
      doc.font("Helvetica").text(` ${company.bank?.accountNumber || "N/A"}`);

      doc.font("Helvetica-Bold").text("Bank Name:", { continued: true });
      doc.font("Helvetica").text(` ${company.bank?.bankName || "N/A"}`);

      doc.font("Helvetica-Bold").text("IFSC Code:", { continued: true });
      doc.font("Helvetica").text(` ${company.bank?.ifsc || "N/A"}`);

      doc.lineGap(0);

      /* ================= ITEMIZED LINK ================= */

      doc.moveDown(1);
      doc
        .fontSize(9)
        .fillColor("blue")
        .text("Download Itemized Shipment Details", 40, doc.y, {
          link: invoice.itemizedUrl,
          underline: true,
        });

      doc.fillColor("black");

      /* ================= FOOTER ================= */

      doc
        .fontSize(8)
        .text(
          "This is a computer generated invoice. No signature required.",
          40,
          doc.page.height - 50,
          { align: "center" },
        );

      doc.end();

      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

/* =========================
   PDF: ITEMIZED AWB
   ========================= */
async function generateItemizedAwbPDF(invoice) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const fileName = `itemized-awb-${invoice.invoiceNumber}.pdf`;
      const outPath = path.join("/tmp", fileName);

      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      doc.fontSize(14).font("Helvetica-Bold").text("Itemized Shipment Details");
      doc.moveDown(1);

      const col = {
        order: 40,
        awb: 120,
        desc: 220,
        date: 380,
        amt: 520,
      };

      const headerY = doc.y;
      doc.fontSize(9).font("Helvetica-Bold");
      doc.text("Order ID", col.order, headerY);
      doc.text("AWB", col.awb, headerY);
      doc.text("Description", col.desc, headerY);
      doc.text("Date", col.date, headerY);
      doc.text("Amount (₹)", col.amt, headerY, { align: "right" });

      doc
        .moveTo(40, headerY + 15)
        .lineTo(550, headerY + 15)
        .stroke();
      doc.y = headerY + 25;

      doc.font("Helvetica").fontSize(9);

      for (const t of invoice.chargesBreakup.transactions) {
        if (doc.y > doc.page.height - 80) doc.addPage();

        const rowY = doc.y;
        const descHeight = doc.heightOfString(t.description || "", {
          width: 140,
        });
        const rowHeight = Math.max(descHeight, 14);

        doc.text(t.channelOrderId || "-", col.order, rowY, { width: 70 });
        doc.text(t.awb || "-", col.awb, rowY, { width: 80 });
        doc.text(t.description || "", col.desc, rowY, { width: 140 });
        doc.text(new Date(t.date).toLocaleDateString(), col.date, rowY);
        doc.text(Number(t.amount || 0).toFixed(2), col.amt, rowY, {
          align: "right",
        });

        doc.y = rowY + rowHeight + 6;
      }

      doc.end();
      stream.on("finish", () => resolve(outPath));
      stream.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

// Upload to S3 and return public URL
async function uploadToS3(localPath, key) {
  const fileContent = fs.readFileSync(localPath);

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME, // from your existing config
      Key: key,
      Body: fileContent,
      ContentType: "application/pdf",
      CacheControl: "no-store, no-cache, must-revalidate, max-age=0",
    }),
  );

  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION
    }.amazonaws.com/${encodeURIComponent(key)}`;
}

/* -------------------------
   Core: Build charges using wallet transactions (allowed descriptions)
   -------------------------*/
async function buildChargesFromWalletTransactions(
  userId,
  periodStart,
  periodEnd,
  previousAwbs = [],
) {
  const user = await User.findById(userId);
  const wallet = await Wallet.findOne({ _id: user.Wallet }).select("_id");
  if (!wallet) return { taxableValue: 0, tax: 0, total: 0, txns: [] };

  const candidateTxns = await WalletTransaction.find({
    walletId: wallet._id,
    category: "debit",
    date: { $gte: periodStart, $lte: periodEnd },
  }).lean();

  const validTxns = [];

  for (const t of candidateTxns) {
    if (!t) continue;
    if (!allowedDescription(t.description)) continue;

    const awb = extractAwbFromTransaction(t);
    if (!awb) continue;
    if (previousAwbs.includes(awb)) continue;

    const order = await Order.findOne({ awb_number: awb }).select(
      "status awb_number",
    );
    if (!order) continue;

    const st = (order.status || "").toLowerCase();
    if (st === "new" || st === "cancelled") continue;

    validTxns.push({
      awb,
      description: t.description,
      amount: Number(t.amount || 0), // already includes GST
      date: t.date,
      balanceAfterTransaction: Number(t.balanceAfterTransaction ?? 0),
      channelOrderId: t.channelOrderId || null,
    });
  }

  const total = Number(
    validTxns.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2),
  );

  // GST extraction (reverse calculation)
  const taxableValue = Number((total / (1 + GST_RATE)).toFixed(2));
  const tax = Number((total - taxableValue).toFixed(2));

  return { taxableValue, tax, total, txns: validTxns };
}

// async function buildChargesFromWalletTransactions(
//   userId,
//   periodStart,
//   periodEnd,
//   previousAwbs = [],
// ) {
//   const user = await User.findById(userId);
//   const wallet = await Wallet.findOne({ _id: user.Wallet });
//   if (!wallet) return { taxableValue: 0, tax: 0, total: 0, txns: [] };

//   // 1️⃣ Fetch eligible orders based on invoiceDate
//   const orders = await Order.find({
//     invoiceDate: { $gte: periodStart, $lte: periodEnd },
//     status: { $nin: ["new", "cancelled"] },
//   }).select("awb_number invoiceDate");

//   const awbSet = new Set(
//     orders
//       .map((o) => o.awb_number)
//       .filter(Boolean)
//       .filter((awb) => !previousAwbs.includes(awb)),
//   );

//   if (awbSet.size === 0) {
//     return { taxableValue: 0, tax: 0, total: 0, txns: [] };
//   }

//   // 2️⃣ Filter wallet debit transactions by AWB
//   const validTxns = (wallet.transactions || [])
//     .filter((t) => {
//       if (!t) return false;

//       if ((t.category || "").toLowerCase() !== "debit") return false;
//       if (!allowedDescription(t.description)) return false;

//       const awb = extractAwbFromTransaction(t);
//       if (!awb || !awbSet.has(awb)) return false;

//       return true;
//     })
//     .map((t) => ({
//       awb: extractAwbFromTransaction(t),
//       description: t.description,
//       amount: Number(t.amount || 0), // already includes GST
//       date: t.date,
//       balanceAfterTransaction: Number(t.balanceAfterTransaction ?? 0),
//       channelOrderId: t.channelOrderId || null,
//     }));

//   // 3️⃣ Calculate totals
//   const total = Number(
//     validTxns.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2),
//   );

//   const taxableValue = Number((total / (1 + GST_RATE)).toFixed(2));
//   const tax = Number((total - taxableValue).toFixed(2));

//   return { taxableValue, tax, total, txns: validTxns };
// }

/* -------------------------
   Controller: Generate monthly invoice for single user
   -------------------------*/

async function generateInvoiceForUserMonth(userId, periodStart, periodEnd) {
  const prevInvoices = await Invoice.find({ userId }, { includedAwbs: 1 });
  const prevAwbs = prevInvoices.flatMap((i) => i.includedAwbs || []);

  const { taxableValue, tax, total, txns } =
    await buildChargesFromWalletTransactions(
      userId,
      periodStart,
      periodEnd,
      prevAwbs,
    );

  if (!txns || txns.length === 0) {
    return { skipped: true, reason: "No chargeable transactions" };
  }

  const invoiceNumber = await generateInvoiceNumber(periodEnd);
  console.log(
    `Generating invoice ${invoiceNumber} for user ${userId} for period:`,
    periodStart,
    periodEnd,
  );
  const user = await User.findById(userId).select(
    "fullname email company Wallet",
  );
  const lastTxnOfPeriod = txns
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .at(-1);

  let status = "PAID";
  let dueAmount = 0;

  if (lastTxnOfPeriod && lastTxnOfPeriod.balanceAfterTransaction < 0) {
    status = "PENDING";
    dueAmount = Math.abs(lastTxnOfPeriod.balanceAfterTransaction);
  }
  console.log("period start", periodStart);
  const invoice = new Invoice({
    userId,
    periodStart,
    periodEnd,
    invoiceDate: periodEnd,
    invoiceNumber,
    totalAmount: total,
    taxableValue,
    tax,
    paidAmount: total - dueAmount,
    dueAmount,
    chargesBreakup: {
      transactionsCount: txns.length,
      transactions: txns,
    },
    includedAwbs: txns.map((t) => t.awb),
    status,
    isFinalized: false,
  });

  await invoice.save();

  // ---------------- ITEMIZED PDF ----------------
  const itemizedPath = await generateItemizedAwbPDF(invoice);
  const itemizedS3Url = await uploadToS3(
    itemizedPath,
    `invoices/${userId}/${invoice.invoiceNumber}-itemized.pdf`,
  );
  invoice.itemizedUrl = itemizedS3Url;

  // ---------------- FETCH USER GST / BILLING ----------------
  const gstin = await GSTIN.findOne({ user: userId });
  const BillingInfo = await billing.findOne({ user: userId });
  const PAN = await Pan.findOne({ user: userId });

  const customerInfo = {
    name: gstin?.nameOfBusiness || gstin?.legalNameOfBusiness || user?.fullname || "N/A",
    address: gstin?.address || BillingInfo?.address || "N/A",
    gstin: gstin?.gstin || "N/A",
    state: gstin?.state || BillingInfo?.state || "N/A",
    pincode: gstin?.pincode || BillingInfo?.postalCode || "N/A",
    pan: PAN?.pan || "N/A",
  };

  // Determine Company Details based on date (April 2026 onwards)
  const isNewBranding = new Date(periodEnd) >= new Date(2026, 8, 1);
  const companyDetails = isNewBranding
    ? {
        name: "Quickpost360 Services Private Limited",
        address:
          "House No 87 Singhal Panna, Gali No2 Near Shiv Mandir, Badesera, Bhiwani, Bhiwani, Haryana, India, 127031",
        phone: "+91- 9813981344",
        email: "support@shipexindia.com",
        gstin: "06AABCQ1885H1ZC",
        cin: "U53200HR2025PTC138342",
        bank: {
          accountName: "Quickpost360 Services Private Limited",
          accountNumber: "258800258800",
          bankName: "Indusind Bank Limited",
          ifsc: "INDB0000673",
        },
      }
    : {
        name: "Shipex India",
        address:
          "01, Basement, Biju Tower, Baba Nagar, Bhiwani, Haryana - 127021",
        phone: "+91- 9813981344",
        email: "support@shipexindia.com",
        pan: "XXXAAABBB",
        gstin: "06FKCPS6109D3Z7",
        bank: {
          accountName: "Shipex India",
          accountNumber: "2258120020000251",
          bankName: "Ujjivan Small Finance Bank",
          ifsc: "UJVN0002258",
        },
      };

  // ---------------- FINAL INVOICE PDF ----------------
  const pdfPath = await generateInvoicePDF(invoice, companyDetails, customerInfo);

  const s3Key = `invoices/${userId}/${invoice.invoiceNumber}.pdf`;
  const s3Url = await uploadToS3(pdfPath, s3Key);

  invoice.s3Url = s3Url;
  invoice.isFinalized = true;
  await invoice.save();

  try {
    fs.unlinkSync(pdfPath);
  } catch (e) {
    console.log("PDF cleanup error:", e);
  }

  return { saved: true, invoice, s3Url };
}

/* -------------------------
   Bulk: Generate invoices for all users for a given period
   -------------------------*/
async function generateInvoicesForPeriod(periodStart, periodEnd) {
  // 1. Fetch only GST-verified users
  const gstUsers = await GSTIN.find(
    { gstInStatus: "Active" }, // condition for verified GST
    { user: 1 }, // only need userId
  );

  const gstUserIds = gstUsers.map((g) => g.user.toString());

  console.log(
    `Generating invoices for ${gstUserIds.length} GST-verified users for period:`,
    periodStart,
    periodEnd,
  );

  const results = [];

  for (const userId of gstUserIds) {
    try {
      const r = await generateInvoiceForUserMonth(
        userId,
        periodStart,
        periodEnd,
      );

      results.push({ userId, result: r });
    } catch (err) {
      results.push({ userId, error: err.message });
    }
  }

  return results;
}

/* -------------------------
   Cron: run daily at 23:59 and trigger generation if tomorrow is 1st (i.e. last day behavior)
   -------------------------*/
async function scheduleMonthlyInvoiceCron() {
  // Runs at 23:59 server time every day
  // cron.schedule("59 23 * * *", async () => {
  console.log("Running monthly invoice cron check...");
  try {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (tomorrow.getDate() !== 1) {
      console.log("Not the end of the month. Skipping invoice generation.");

      return;
    }

    // generate for current month (i.e. month that just finished)
    const year = now.getFullYear();
    const month = now.getMonth(); // current month index
    const periodStart = new Date(year, month, 1);
    const periodEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);
    // console.log("Monthly invoice cron triggered for period:", periodStart, periodEnd);
    console.log(
      "Running monthly invoice generation for:",
      periodStart,
      periodEnd,
    );
    const results = await generateInvoicesForPeriod(periodStart, periodEnd);
    // console.log("result", results);
    console.log(
      "Monthly invoice results:",
      results.filter((r) => r.result || r.error).slice(0, 10),
    );
    // Consider logging results to DB or file for auditing
  } catch (err) {
    console.error("Monthly invoice cron error:", err);
  }
  // });
}
if (process.env.NODE_ENV === "production") {
  cron.schedule(
    "5 0 1 * *", // 12:05 AM on 1st day of every month
    async () => {
      await scheduleMonthlyInvoiceCron();
    },
    {
      timezone: "Asia/Kolkata",
    },
  );
}
// scheduleMonthlyInvoiceCron()
// console.log("Monthly invoice cron scheduled.");

async function scheduleMonthlyInvoiceCronn({ forcePeriod } = {}) {
  console.log("Running monthly invoice cron check...");

  try {
    const now = new Date();

    let periodStart;
    let periodEnd;

    if (forcePeriod) {
      // 🔁 ONE-TIME manual backfill
      periodStart = forcePeriod.start;
      periodEnd = forcePeriod.end;

      console.log("⚠️ Running MANUAL backfill for:", periodStart, periodEnd);
    } else {
      // ✅ Normal month-end logic
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);

      if (tomorrow.getDate() !== 1) {
        console.log("Not the end of the month. Skipping invoice generation.");
        return;
      }

      const year = now.getFullYear();
      const month = now.getMonth();

      const start = new Date(2026, 0, 1);
      start.setHours(0, 0, 0, 0);

      const end = new Date(2026, 1, 0);
      end.setHours(23, 59, 59, 999);

      periodStart = start;
      periodEnd = end;
    }

    console.log("Generating invoice for period:", periodStart, periodEnd);

    const results = await generateInvoicesForPeriod(periodStart, periodEnd);

    console.log(
      "Monthly invoice results:",
      results.filter((r) => r.result || r.error).slice(0, 10),
    );
  } catch (err) {
    console.error("Monthly invoice cron error:", err);
  }
}

// (async () => {
//   await scheduleMonthlyInvoiceCronn({
//     forcePeriod: {
//       start: new Date(2026, 0, 1, 0, 0, 0, 0),     // Jan 1, 12:00 AM IST
//       end: new Date(2026, 1, 0, 23, 59, 59, 999), // Jan 31, 11:59:59 PM IST
//     },
//   });

//   console.log("✅ January invoice backfill completed");
// })();

const bulkDownloadInvoices = async (req, res) => {
  try {
    const { invoiceNumbers } = req.query;
    console.log("Bulk download invoice ids:", invoiceNumbers);

    if (!invoiceNumbers) {
      return res.status(400).json({ message: "Invoice IDs required" });
    }

    // Convert comma-separated string to ObjectId[]
    const invoiceIds = invoiceNumbers
      .split(",")
      .map((id) => new mongoose.Types.ObjectId(id));

    const invoices = await Invoice.find({
      _id: { $in: invoiceIds },
      s3Url: { $exists: true },
    }).sort({ createdAt: 1 });

    if (!invoices.length) {
      return res.status(404).json({ message: "No invoices found" });
    }

    const mergedPdf = await PDFLibDocument.create();

    for (const inv of invoices) {
      const pdfBytes = await axios.get(inv.s3Url, {
        responseType: "arraybuffer",
      });

      const pdf = await PDFLibDocument.load(pdfBytes.data);

      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());

      pages.forEach((page) => mergedPdf.addPage(page));
    }

    const finalPdfBytes = await mergedPdf.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="Invoices_${Date.now()}.pdf"`,
    );

    return res.send(Buffer.from(finalPdfBytes));
  } catch (err) {
    console.error("Bulk invoice download error:", err);
    return res
      .status(500)
      .json({ message: "Failed to generate bulk invoice PDF" });
  }
};

/* -------------------------------------------------------
   Helper: Build Query From req.query
----------------------------------------------------------*/
const buildInvoiceFilters = (query) => {
  const filters = {};

  if (query.userId) filters.userId = query.userId;
  if (query.invoiceNumber) filters.invoiceNumber = query.invoiceNumber;

  let month = query.month ? Number(query.month) - 1 : null;
  let year = query.year ? Number(query.year) : null;

  // ⭐ If user selects month but NOT year → auto-set current year
  if (month !== null && year === null) {
    year = new Date().getFullYear();
  }

  // ⭐ Case 1: Month + Year → Filter by specific month
  // Use periodEnd only (indexed) — all invoices end on the last day of the billing month
  if (month !== null && year !== null) {
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 1);

    filters.periodEnd = { $gte: startDate, $lt: endDate };
    return filters;
  }

  // ⭐ Case 2: Year only → Filter entire year using periodEnd (indexed)
  if (month === null && year !== null) {
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year + 1, 0, 1);

    filters.periodEnd = { $gte: startOfYear, $lt: endOfYear };
    return filters;
  }

  // ⭐ Case 3: No month & no year → return all invoices
  return filters;
};

/* -------------------------------------------------------
   Admin Controller — Fetch All Invoices
----------------------------------------------------------*/
const adminGetInvoices = async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const { page = 1, limit = 20 } = req.query;

    const parsedLimit =
      typeof limit === "string" && limit.toLowerCase() === "all"
        ? null
        : Number(limit);

    const finalLimit =
      parsedLimit === null || isNaN(parsedLimit) ? null : parsedLimit;

    const skip = finalLimit ? (Number(page) - 1) * finalLimit : 0;

    const filters = buildInvoiceFilters(req.query);

    // 🔥 Fetch paginated data + count in parallel
    const [invoices, totalCount] = await Promise.all([
      finalLimit === null
        ? Invoice.find(filters)
          .select("invoiceNumber includedAwbs invoiceDate createdAt periodStart periodEnd s3Url totalAmount status userId")
          .sort({ createdAt: -1 })
          .lean()
        : Invoice.find(filters)
          .select("invoiceNumber includedAwbs invoiceDate createdAt periodStart periodEnd s3Url totalAmount status userId")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(finalLimit)
          .lean(),
      Invoice.countDocuments(filters),
    ]);

    if (!invoices.length) {
      return res.json({
        success: true,
        totalCount: 0,
        page: 0,
        currentPage: Number(page),
        limit: finalLimit ?? "All",
        invoices: [],
      });
    }

    const userIds = [...new Set(invoices.map((i) => i.userId))];

    const users = await User.find(
      { _id: { $in: userIds } },
      { fullname: 1, email: 1, phoneNumber: 1, userId: 1 },
    ).lean();

    const userMap = {};
    users.forEach((u) => {
      userMap[u._id] = {
        fullname: u.fullname || "",
        email: u.email || "",
        phoneNumber: u.phoneNumber || "",
        userId: u.userId || "",
      };
    });

    const result = invoices.map((inv) => ({
      _id: inv._id,
      invoiceNumber: inv.invoiceNumber,
      totalShipments: inv.includedAwbs?.length || 0,
      invoiceDate: (inv.invoiceDate || inv.createdAt).toISOString().split("T")[0],
      periodStart: inv.periodStart?.toISOString().split("T")[0] || null,
      periodEnd: inv.periodEnd?.toISOString().split("T")[0] || null,
      invoiceUrl: inv.s3Url || null,
      amount: inv.totalAmount,
      status: inv.status,
      userId: inv.userId,
      userDetails: userMap[inv.userId] || {},
    }));

    const totalPages = finalLimit ? Math.ceil(totalCount / finalLimit) : 1;

    return res.json({
      success: true,
      totalCount,
      page: totalPages, // total pages
      currentPage: Number(page),
      limit: finalLimit ?? "All",
      invoices: result,
    });
  } catch (err) {
    console.error("adminGetInvoices error:", err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* -------------------------------------------------------
   User Controller — Get Only Logged-in User's Invoices
----------------------------------------------------------*/
const userGetInvoices = async (req, res) => {
  try {
    const userId = req.user._id;

    const { page = 1, limit = 20 } = req.query;

    const parsedLimit =
      typeof limit === "string" && limit.toLowerCase() === "all"
        ? null
        : Number(limit);

    const finalLimit =
      parsedLimit === null || isNaN(parsedLimit) ? null : parsedLimit;

    const skip = finalLimit ? (Number(page) - 1) * finalLimit : 0;

    // Apply filters + force user restriction
    const filters = buildInvoiceFilters(req.query);
    filters.userId = userId;

    // 🔥 Run data + count in parallel
    const [invoices, totalCount] = await Promise.all([
      finalLimit === null
        ? Invoice.find(filters)
          .select("invoiceNumber includedAwbs invoiceDate createdAt periodStart periodEnd s3Url totalAmount status")
          .sort({ createdAt: -1 })
          .lean()
        : Invoice.find(filters)
          .select("invoiceNumber includedAwbs invoiceDate createdAt periodStart periodEnd s3Url totalAmount status")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(finalLimit)
          .lean(),
      Invoice.countDocuments(filters),
    ]);

    if (!invoices.length) {
      return res.json({
        success: true,
        totalCount: 0,
        page: 0,
        currentPage: Number(page),
        limit: finalLimit ?? "All",
        invoices: [],
      });
    }

    const result = invoices.map((inv) => ({
      _id: inv._id,
      invoiceNumber: inv.invoiceNumber,
      totalShipments: inv.includedAwbs?.length || 0,
      invoiceDate: (inv.invoiceDate || inv.createdAt).toISOString().split("T")[0],
      periodStart: inv.periodStart?.toISOString().split("T")[0] || null,
      periodEnd: inv.periodEnd?.toISOString().split("T")[0] || null,
      invoiceUrl: inv.s3Url || null,
      amount: inv.totalAmount,
      status: inv.status,
    }));

    const totalPages = finalLimit ? Math.ceil(totalCount / finalLimit) : 1;

    return res.json({
      success: true,
      totalCount,
      page: totalPages,
      currentPage: Number(page),
      limit: finalLimit ?? "All",
      invoices: result,
    });
  } catch (err) {
    console.error("userGetInvoices error:", err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const exportInvoiceToExcel = async (req, res) => {
  try {
    const { invoiceNumber } = req.query;

    if (!invoiceNumber) {
      return res.status(400).json({ success: false, message: "Invoice number is required" });
    }

    const invoice = await Invoice.findOne({ invoiceNumber });
    if (!invoice) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const transactions = invoice.chargesBreakup?.transactions || [];
    if (!transactions.length) {
      return res.status(404).json({ success: false, message: "No transactions found for this invoice" });
    }

    const awbs = [...new Set(transactions.map((t) => t.awb).filter(Boolean))];
    const orders = await Order.find({ awb_number: { $in: awbs } });
    const orderMap = new Map(orders.map((o) => [o.awb_number, o]));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Invoice Details");

    worksheet.columns = [
      { header: "Order ID", key: "orderId", width: 15 },
      { header: "AWB Number", key: "awb_number", width: 20 },
      { header: "Description", key: "txnDescription", width: 40 },
      { header: "Status", key: "status", width: 15 },
      { header: "Pickup Name", key: "pickupName", width: 20 },
      { header: "Pickup Phone", key: "pickupPhone", width: 15 },
      { header: "Pickup City", key: "pickupCity", width: 15 },
      { header: "Pickup Pincode", key: "pickupPincode", width: 12 },
      { header: "Receiver Name", key: "customerName", width: 20 },
      { header: "Receiver Phone", key: "customerPhone", width: 15 },
      { header: "Receiver City", key: "customerCity", width: 15 },
      { header: "Receiver Pincode", key: "customerPincode", width: 12 },
      { header: "Products", key: "products", width: 40 },
      { header: "Weight", key: "weight", width: 12 },
      { header: "Length", key: "length", width: 10 },
      { header: "Width", key: "width", width: 10 },
      { header: "Height", key: "height", width: 10 },
      { header: "Payment Method", key: "paymentMode", width: 15 },
      { header: "Payment Amount", key: "amount", width: 15 },
      { header: "Freight", key: "freight", width: 12 },
      { header: "COD Charges", key: "codCharges", width: 12 },
      { header: "GST", key: "gst", width: 12 },
      { header: "Total Shipping", key: "totalShipping", width: 15 },
      { header: "Courier Service Name", key: "courierServiceName", width: 25 },
      { header: "Booked On", key: "shipmentCreatedAt", width: 25 },
    ];

    transactions.forEach((txn) => {
      const order = orderMap.get(txn.awb);
      worksheet.addRow({
        orderId: order?.orderId || txn.channelOrderId || "N/A",
        awb_number: txn.awb,
        txnDescription: txn.description || "N/A",
        status: order?.status || "N/A",
        pickupName: order?.pickupAddress?.contactName || "N/A",
        pickupPhone: order?.pickupAddress?.phoneNumber || "N/A",
        pickupCity: order?.pickupAddress?.city || "N/A",
        pickupPincode: order?.pickupAddress?.pinCode || "N/A",
        customerName: order?.receiverAddress?.contactName || "N/A",
        customerPhone: order?.receiverAddress?.phoneNumber || "N/A",
        customerCity: order?.receiverAddress?.city || "N/A",
        customerPincode: order?.receiverAddress?.pinCode || "N/A",
        products: order?.productDetails?.map(p => `${p.name} (${p.sku || 'No SKU'}) x ${p.quantity}`).join(" | ") || "N/A",
        weight: order?.packageDetails?.applicableWeight || order?.packageDetails?.deadWeight || 0,
        length: order?.packageDetails?.volumetricWeight?.length || 0,
        width: order?.packageDetails?.volumetricWeight?.width || 0,
        height: order?.packageDetails?.volumetricWeight?.height || 0,
        paymentMode: order?.paymentDetails?.method || "N/A",
        amount: order?.paymentDetails?.amount || 0,
        freight: order?.priceBreakup?.freight || 0,
        codCharges: order?.priceBreakup?.cod || 0,
        gst: order?.priceBreakup?.gst || 0,
        totalShipping: txn.amount || order?.totalFreightCharges || 0,
        courierServiceName: order?.courierServiceName || "N/A",
        shipmentCreatedAt: order?.shipmentCreatedAt ? moment(order.shipmentCreatedAt).format("DD-MM-YYYY HH:mm") : "N/A",
      });
    });

    // Formatting headers
    worksheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Invoice_${invoiceNumber}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.status(200).end();
  } catch (err) {
    console.error("Export to Excel error:", err);
    res.status(500).json({ success: false, message: "Failed to export Excel" });
  }
};

async function regenerateInvoicePDFsForPeriod(periodStart, periodEnd) {
  const invoices = await Invoice.find({
    periodEnd: {
      $gte: periodStart,
      $lte: periodEnd,
    },
  });

  console.log(`Found ${invoices.length} invoices to regenerate for period ${periodStart} - ${periodEnd}`);

  for (const invoice of invoices) {
    try {
      const userId = invoice.userId;
      const user = await User.findById(userId).select("fullname email company Wallet");
      const gstin = await GSTIN.findOne({ user: userId });
      const BillingInfo = await billing.findOne({ user: userId });
      const PAN = await Pan.findOne({ user: userId });

      const customerInfo = {
        name: gstin?.nameOfBusiness || gstin?.legalNameOfBusiness || user?.fullname || "N/A",
        address: gstin?.address || BillingInfo?.address || "N/A",
        gstin: gstin?.gstin || "N/A",
        state: gstin?.state || BillingInfo?.state || "N/A",
        pincode: gstin?.pincode || BillingInfo?.postalCode || "N/A",
        pan: PAN?.pan || "N/A",
      };

      const isNewBranding = new Date(invoice.periodEnd) >= new Date(2026, 8, 1);
      const companyDetails = isNewBranding
        ? {
            name: "Quickpost360 Services Private Limited",
            address:
              "House No 87 Singhal Panna, Gali No2 Near Shiv Mandir, Badesera, Bhiwani, Bhiwani, Haryana, India, 127031",
            phone: "+91- 9813981344",
            email: "support@shipexindia.com",
            gstin: "06AABCQ1885H1ZC",
            cin: "U53200HR2025PTC138342",
            bank: {
              accountName: "Quickpost360 Services Private Limited",
              accountNumber: "258800258800",
              bankName: "Indusind Bank Limited",
              ifsc: "INDB0000673",
            },
          }
        : {
            name: "Shipex India",
            address:
              "01, Basement, Biju Tower, Baba Nagar, Bhiwani, Haryana - 127021",
            phone: "+91- 9813981344",
            email: "support@shipexindia.com",
            pan: "XXXAAABBB",
            gstin: "06FKCPS6109D3Z7",
            bank: {
              accountName: "Shipex India",
              accountNumber: "2258120020000251",
              bankName: "Ujjivan Small Finance Bank",
              ifsc: "UJVN0002258",
            },
          };

      const pdfPath = await generateInvoicePDF(invoice, companyDetails, customerInfo);
      const s3Key = `invoices/${userId}/${invoice.invoiceNumber}.pdf`;
      const s3Url = await uploadToS3(pdfPath, s3Key);

      invoice.s3Url = s3Url;
      await invoice.save();

      try {
        fs.unlinkSync(pdfPath);
      } catch (e) {
        console.log("PDF cleanup error:", e);
      }

      console.log(`Successfully regenerated invoice ${invoice.invoiceNumber} for user ${userId}`);
    } catch (err) {
      console.error(`Error regenerating invoice ${invoice.invoiceNumber}:`, err);
    }
  }
}

/* -------------------------------------------------------
   Rename April/May 2026 QPS2627-* invoices → SFC2627-*
----------------------------------------------------------*/
async function renameQPStoSFC(req, res) {
  try {
    // Find all invoices whose number starts with QPS2627
    const invoices = await Invoice.find({ invoiceNumber: /^QPS2627-/ });

    console.log(`[renameQPStoSFC] Found ${invoices.length} QPS2627 invoices to rename.`);

    if (!invoices.length) {
      return res.json({ success: true, message: "No QPS2627 invoices found. Nothing to rename." });
    }

    const results = { success: [], failed: [] };
    let maxSeq = 0;

    // Shipex India branding (same as pre-Sep 2026)
    const companyDetails = {
      name: "Shipex India",
      address: "01, Basement, Biju Tower, Baba Nagar, Bhiwani, Haryana - 127021",
      phone: "+91- 9813981344",
      email: "support@shipexindia.com",
      pan: "XXXAAABBB",
      gstin: "06FKCPS6109D3Z7",
      bank: {
        accountName: "Shipex India",
        accountNumber: "2258120020000251",
        bankName: "Ujjivan Small Finance Bank",
        ifsc: "UJVN0002258",
      },
    };

    for (const invoice of invoices) {
      try {
        const oldNumber = invoice.invoiceNumber;
        const seqStr = oldNumber.split("-")[1];           // e.g. "0000035"
        const seq = parseInt(seqStr, 10);
        if (seq > maxSeq) maxSeq = seq;

        const newNumber = `SFC2627-${seqStr}`;
        const userId = invoice.userId;

        // Load customer info
        const user = await User.findById(userId).select("fullname email Wallet");
        const gstin = await GSTIN.findOne({ user: userId });
        const BillingInfo = await billing.findOne({ user: userId });
        const PAN = await Pan.findOne({ user: userId });

        const customerInfo = {
          name: gstin?.nameOfBusiness || gstin?.legalNameOfBusiness || user?.fullname || "N/A",
          address: gstin?.address || BillingInfo?.address || "N/A",
          gstin: gstin?.gstin || "N/A",
          state: gstin?.state || BillingInfo?.state || "N/A",
          pincode: gstin?.pincode || BillingInfo?.postalCode || "N/A",
          pan: PAN?.pan || "N/A",
        };

        // Update invoice number in memory before PDF generation
        invoice.invoiceNumber = newNumber;

        // Regenerate PDF
        const pdfPath = await generateInvoicePDF(invoice, companyDetails, customerInfo);
        const s3Key = `invoices/${userId}/${newNumber}.pdf`;
        const s3Url = await uploadToS3(pdfPath, s3Key);

        invoice.s3Url = s3Url;
        await invoice.save();

        try { fs.unlinkSync(pdfPath); } catch (e) {}

        console.log(`  ✅ ${oldNumber} → ${newNumber}`);
        results.success.push({ old: oldNumber, new: newNumber, s3Url });
      } catch (err) {
        console.error(`  ❌ Error for ${invoice.invoiceNumber}:`, err.message);
        results.failed.push({ invoiceNumber: invoice.invoiceNumber, error: err.message });
      }
    }

    // Fix invoice counter: remove QPS2627, set SFC2627 to maxSeq
    await InvoiceCounter.deleteOne({ key: "QPS2627" });
    await InvoiceCounter.findOneAndUpdate(
      { key: "SFC2627" },
      { $set: { seq: maxSeq } },
      { upsert: true, new: true }
    );
    console.log(`[renameQPStoSFC] Counter: SFC2627 = ${maxSeq}, QPS2627 deleted.`);

    return res.json({
      success: true,
      message: `Renamed ${results.success.length} invoices. ${results.failed.length} failed.`,
      renamed: results.success,
      failed: results.failed,
    });
  } catch (err) {
    console.error("[renameQPStoSFC] Fatal error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/* -------------------------
   Exports (controllers)
   -------------------------*/
module.exports = {
  buildChargesFromWalletTransactions,
  generateInvoiceForUserMonth,
  generateInvoicesForPeriod,
  scheduleMonthlyInvoiceCron,
  adminGetInvoices,
  userGetInvoices,
  bulkDownloadInvoices,
  exportInvoiceToExcel,
  regenerateInvoicePDFsForPeriod,
  renameQPStoSFC,
};
