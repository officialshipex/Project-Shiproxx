const express = require("express");
const PDFDocument = require("pdfkit");
const Order = require("../models/newOrder.model");
const sharp = require("sharp"); // (not used below—keep if you plan to)
const fs = require("fs");
const path = require("path");

const app = express();

app.get("/download-invoice/:id", async (req, res) => {
  const id = req.params.id;
  const order = await Order.findOne({ _id: id });
  if (!order) {
    return res.status(404).send("Order not found");
  }

  // Helpers
  const s = (v) => (v === null || v === undefined ? "" : String(v));
  const n = (v, f = 0) => {
    const num = Number(v);
    return Number.isFinite(num) ? num : f;
  };
  const f2 = (v) => n(v, 0).toFixed(2);

  // Create PDF
  const doc = new PDFDocument({ margin: 40 });
  const filename = "invoice.pdf";

  // Headers
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  // Logo
  try {
    const jpgLogoPath = path.join(__dirname, "../public/assets/Shiproxx.jpg");
    if (fs.existsSync(jpgLogoPath)) {
      doc.image(jpgLogoPath, 220, 40, { width: 170 });
    }
  } catch (_) {
    // ignore logo errors (won't affect layout)
  }

  doc.moveDown(8);

  // Title
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(0.3);
  doc.fontSize(16).text("Tax Invoice", { align: "center" }).moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown(1);

  // === Three-column header blocks ===
  const col1X = 50;
  const col1W = 180;
  const col2X = 250;
  const col2W = 130;
  const col3X = 400;
  const col3W = 150;

  const startY = doc.y;

  function drawBlock(x, y, width, title, lines) {
    doc.fontSize(10).text(title, x, y, { width, continued: false });

    let currentY = doc.y + 2; // small space after title
    lines.forEach((line) => {
      if (line) {
        doc.text(line, x, currentY, {
          width,
          lineGap: 4, // 👈 adds spacing between lines
        });
        currentY = doc.y + 2;
      }
    });

    return currentY;
  }

  const pickup = order.pickupAddress || {};
  const receiver = order.receiverAddress || {};
  const payMethod = s(order?.paymentDetails?.method || "N/A");

  // SHIPPING ADDRESS (left)
  const b1 = drawBlock(col1X, startY, col1W, "SHIPPING ADDRESS:", [
    s(receiver.contactName),
    s(receiver.address),
    s(receiver.city),
    s(receiver.state),
    s(receiver.pinCode),
    s(receiver.phoneNumber),
  ]);

  // SOLD BY (middle) — using receiver here is typical; change if needed
  const b2 = drawBlock(col2X, startY, col2W, "SOLD BY:", [
    s(pickup.contactName),
    s(pickup.address),
    s(pickup.city),
    s(pickup.state),
    s(pickup.pinCode),
    `Phone: ${s(pickup.phoneNumber)}`,
    `GSTIN: ${(order.otherDetails.gstin)}`,
    `Email: ${s(pickup.email)}`,
  ]);

  // INVOICE DETAILS (right)
  const currentDate = new Date();
  const options = { year: "numeric", month: "short", day: "numeric" };
  const formattedCurrentDate = currentDate.toLocaleDateString("en-US", options);
  const orderCreatedDate = new Date(order.createdAt);
  const formattedOrderDate = orderCreatedDate.toLocaleDateString(
    "en-US",
    options
  );

  const b3 = drawBlock(col3X, startY, col3W, "INVOICE DETAILS:", [
    "Invoice No: INV-626796",
    `Invoice Date: ${formattedCurrentDate}`,
    `Order No: ${s(order.orderId)}`,
    `Order Date: ${formattedOrderDate}`,
    "Channel: SHIPROXX",
    `Payment Method: ${payMethod}`,
  ]);

  // Move cursor to below the tallest block
  const afterBlocksY = Math.max(b1, b2, b3) + 12;
  doc.y = afterBlocksY;

  // === Table ===
  const tableLeft = 50;
  const tableWidth = 500;
  const tableRight = tableLeft + tableWidth; // 550
  const colWidths = [40, 150, 70, 80, 50, 50, 60]; // sums to 500
  const minRowHeight = 20;
  const cellPad = 4;

  const pageTop = doc.page.margins.top;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;

  function measureRowHeight(row) {
    // Compute max cell height for the row
    const heights = row.map((text, i) =>
      doc.heightOfString(s(text), {
        width: colWidths[i] - 2 * cellPad,
        align: i === 1 ? "left" : "center",
      })
    );
    return Math.max(minRowHeight, ...heights) + 2 * cellPad;
  }

  function drawRow(row, y, isHeader = false) {
    // Draw cell borders and text at fixed Y
    let x = tableLeft;
    const rowHeight = measureRowHeight(row);

    // Background for header (optional)
    if (isHeader) {
      doc.rect(tableLeft, y, tableWidth, rowHeight).stroke(); // add .fillColor(..).fill() if you want
    }

    // Draw vertical lines and text
    for (let i = 0; i < colWidths.length; i++) {
      // cell border
      doc.rect(x, y, colWidths[i], rowHeight).stroke();

      // text alignment: left for product name, center for others
      const align = i === 1 ? "left" : "center";
      const textX = x + cellPad;
      const textY = y + cellPad;

      // Capture and restore doc.y to avoid drift
      const prevY = doc.y;
      doc.text(s(row[i]), textX, textY, {
        width: colWidths[i] - 2 * cellPad,
        align,
      });
      doc.y = prevY;

      x += colWidths[i];
    }
    return y + rowHeight; // next Y
  }

  function ensureTableSpace(nextRowHeight, currentY, wantHeader) {
    // If next row would overflow, add page and optionally redraw header
    if (currentY + nextRowHeight > pageBottom()) {
      doc.addPage();
      currentY = doc.y = pageTop;
      if (wantHeader) {
        currentY = drawRow(
          [
            "S.No",
            "Product Name",
            "SKU",
            "HSN",
            "Quantity",
            "Unit Price",
            "SGST",
            "CGST",
            "Total",
          ],
          currentY,
          true
        );
      }
    }
    return currentY;
  }

  // Draw header
  doc.font("Helvetica-Bold").fontSize(12);
  let y = drawRow(
    ["S.No", "Product Name","SKU","HSN", "Quantity", "Unit Price", "SGST", "CGST", "Total"],
    doc.y,
    true
  );

  doc.font("Helvetica").fontSize(12);

  const items = Array.isArray(order.productDetails) ? order.productDetails : [];

  // Draw rows
  for (let i = 0; i < items.length; i++) {
    const p = items[i] || {};
    const qty = n(p.quantity, 0);
    const unit = n(p.unitPrice, 0);
    const sgst = n(p.sgst, 0);
    const cgst = n(p.cgst, 0);
    const total = qty * unit; // tax columns shown separately; adjust if needed

    const row = [
      String(i + 1),
      s(p.name),
      s(p.sku),
      String(qty),
      f2(unit),
      f2(sgst),
      f2(cgst),
      f2(total),
    ];

    const rh = measureRowHeight(row);
    y = ensureTableSpace(rh, y, true);
    y = drawRow(row, y, false);
  }

  // === Net Total ===
  const netTotal = items.reduce(
    (sum, p) => sum + n(p.quantity, 0) * n(p.unitPrice, 0),
    0
  );
  const netLineHeight = doc.heightOfString("A", { width: 100 }) + 10;

  // If not enough room for total, go to new page
  if (y + netLineHeight > pageBottom()) {
    doc.addPage();
    y = pageTop;
  } else {
    y += 10; // move down a bit before writing
  }

  // Draw Net Total aligned to right
  doc
    .fontSize(14)
    .text(
      `Net Total (In Value) Rs. ${f2(netTotal)}`,
      doc.page.margins.left,
      y,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: "right",
      }
    );

  y = doc.y; // update y after writing

  doc.end();
});

module.exports = app;
