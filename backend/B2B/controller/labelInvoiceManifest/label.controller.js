const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const https = require("https");

const Order = require("../../../models/newOrder.model");

/* ===============================
   IMAGE FETCH HELPER
================================ */
const fetchImageBuffer = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });

/* ===============================
   CONTROLLER
================================ */
exports.generateLabel = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || order.orderType !== "B2B") {
      return res.status(400).send("Invalid B2B order");
    }

    const masterAwb = order.awb_number;
    const lrn = order.lrn || "N/A";
    const oid = order.oid || "N/A";
    const orderId = order.orderId;

    const childAwbs = order.child_awb_numbers || [];
    const totalBoxes = 1 + childAwbs.length;

    const paymentType =
      order.paymentDetails?.method?.toUpperCase() === "COD" ? "COD" : "PREPAID";

    const doc = new PDFDocument({ size: "A4", margin: 0 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=B2B-Label-${orderId}.pdf`
    );
    doc.pipe(res);

    /* ===============================
       LOGOS
    ================================ */
    const shiproxxLogo = await fetchImageBuffer(
      "https://shiproxx-india.s3.ap-south-1.amazonaws.com/uploads/1767099868221_Shiproxx.jpg"
    );

    const courierLogo = await fetchImageBuffer(
      "https://shiproxx-india.s3.ap-south-1.amazonaws.com/uploads/1767333425857_Delhivery.png"
    );

    /* ===============================
       LABEL & PAGE CONFIG
    ================================ */
    const LABEL_W = 265;
    const LABEL_H = 320; // ⬅ reduced height
    const GAP = 16; // ⬅ tighter gap

    const PAGE_W = 595;
    const PAGE_H = 842;

    const GRID_W = LABEL_W * 2 + GAP;
    const GRID_H = LABEL_H * 2 + GAP;

    const START_X = (PAGE_W - GRID_W) / 2;
    const START_Y = (PAGE_H - GRID_H) / 2;

    let col = 0;
    let row = 0;

    const drawLabel = async ({ awb, boxNo, type }) => {
      if ((boxNo - 1) % 4 === 0 && boxNo !== 1) {
        doc.addPage();
        col = 0;
        row = 0;
      }

      const x = START_X + col * (LABEL_W + GAP);
      const y = START_Y + row * (LABEL_H + GAP);
      let cy = y;

      /* OUTER BORDER */
      doc.rect(x, y, LABEL_W, LABEL_H).stroke();

      /* ================= LOGO ROW ================= */
      const LOGO_H = 36;
      doc.rect(x, cy, LABEL_W, LOGO_H).stroke();
      doc
        .moveTo(x + LABEL_W / 2, cy)
        .lineTo(x + LABEL_W / 2, cy + LOGO_H)
        .stroke();

      doc.image(courierLogo, x + 10, cy + 9, { width: 60 });
      doc.image(shiproxxLogo, x + LABEL_W / 2 + 10, cy + 6, { width: 60 });

      cy += LOGO_H;

      /* ================= META ROW ================= */
      const META_H = 40;
      doc.rect(x, cy, LABEL_W, META_H).stroke();
      doc
        .moveTo(x + LABEL_W / 2, cy)
        .lineTo(x + LABEL_W / 2, cy + META_H)
        .stroke();

      doc.font("Helvetica-Bold").fontSize(7.5);
      doc.text(`Order ID: ${orderId}`, x + 6, cy + 5);
      doc.text(`Master AWB: ${masterAwb}`, x + 6, cy + 20);

      doc.text(`LRN: ${lrn}`, x + LABEL_W / 2 + 6, cy + 5);
      doc.text(`OID: ${oid}`, x + LABEL_W / 2 + 6, cy + 20);

      cy += META_H;

      /* ================= BARCODE ROW ================= */
      const BAR_H = 48;
      doc.rect(x, cy, LABEL_W, BAR_H).stroke();

      const barcode = await bwipjs.toBuffer({
        bcid: "code128",
        text: String(awb),
        scale: 1.2,
        height: 6,
        includetext: false,
      });

      const BAR_W = LABEL_W * 0.7;
      doc.image(barcode, x + (LABEL_W - BAR_W) / 2, cy + 6, {
        width: BAR_W,
      });

      doc
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .text(awb, x, cy + 40, {
          width: LABEL_W,
          align: "center",
        });

      cy += BAR_H;

      /* ================= BOX / PAYMENT ROW ================= */
      const INFO_H = 26;
      doc.rect(x, cy, LABEL_W, INFO_H).stroke();
      doc
        .moveTo(x + LABEL_W / 2, cy)
        .lineTo(x + LABEL_W / 2, cy + INFO_H)
        .stroke();

      doc.text(`Box: ${boxNo}/${totalBoxes}`, x + 6, cy + 5);
      doc.text(`Payment: ${paymentType}`, x + 6, cy + 15);
      doc.text(type, x + LABEL_W / 2 + 6, cy + 10);

      cy += INFO_H;

      /* ================= SHIPPING ================= */
      const SHIP_H = 86;
      doc.rect(x, cy, LABEL_W, SHIP_H).stroke();

      doc
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .text("Shipping Address:", x + 6, cy + 4);

      doc
        .font("Helvetica")
        .fontSize(7.5)
        .text(
          `${order.receiverAddress.contactName}
${order.receiverAddress.address}
${order.receiverAddress.city}, ${order.receiverAddress.state} - ${order.receiverAddress.pinCode}
Ph: ${order.receiverAddress.phoneNumber}`,
          x + 6,
          cy + 16,
          { width: LABEL_W - 12 }
        );

      cy += SHIP_H;

      /* ================= RETURN ================= */
      const RETURN_H = LABEL_H - (cy - y);
      doc.rect(x, cy, LABEL_W, RETURN_H).stroke();

      doc
        .font("Helvetica-Bold")
        .fontSize(7.5)
        .text("Return Address:", x + 6, cy + 4);

      doc
        .font("Helvetica")
        .fontSize(7.5)
        .text(
          `${order.pickupAddress.contactName}
${order.pickupAddress.address}
${order.pickupAddress.city}, ${order.pickupAddress.state} - ${order.pickupAddress.pinCode}`,
          x + 6,
          cy + 16,
          { width: LABEL_W - 12 }
        );

      col++;
      if (col === 2) {
        col = 0;
        row++;
      }
    };

    /* ================= MASTER ================= */
    await drawLabel({ awb: masterAwb, boxNo: 1, type: "Master" });

    /* ================= CHILD ================= */
    for (let i = 0; i < childAwbs.length; i++) {
      await drawLabel({
        awb: childAwbs[i],
        boxNo: i + 2,
        type: "Child",
      });
    }

    doc.end();
  } catch (err) {
    console.error("B2B Label Error:", err);
    if (!res.headersSent) {
      res.status(500).send("Failed to generate label");
    }
  }
};
