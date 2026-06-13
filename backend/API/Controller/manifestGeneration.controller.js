const express = require("express");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const bwipjs = require("bwip-js");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { s3 } = require("../../config/s3");
const Order = require("../../models/newOrder.model");

const app = express();
app.use(cors());

const generateManifest = async (req, res) => {
  try {
    const { awbs } = req.body;

    if (!awbs || !Array.isArray(awbs) || awbs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "AWB array is required (e.g. { awbs: ['AWB1','AWB2'] })",
      });
    }

    const orders = await Order.find({ awb_number: { $in: awbs } });

    if (!orders.length) {
      return res
        .status(404)
        .json({ success: false, message: "Orders not found" });
    }

    const manifestResults = [];

    for (const order of orders) {
      // ✅ Check if this order belongs to logged-in user
      if (order.userId.toString() !== req.user._id.toString()) {
        manifestResults.push({
          awb: order.awb_number,
          message: "Order not found or unauthorized",
        });
        continue;
      }

      // ✅ If manifest already exists, skip regeneration
      if (order.manifest) {
        manifestResults.push({
          awb: order.awb_number,
          manifest: order.manifest,
          message: "Manifest already exists",
        });
        continue;
      }

      // ===============================
      // CREATE PDF EXACTLY AS ORIGINAL
      // ===============================
      const doc = new PDFDocument({ margin: 30 });
      const writablePath = path.join(
        __dirname,
        `${order.awb_number}_manifest.pdf`
      );
      const stream = fs.createWriteStream(writablePath);
      doc.pipe(stream);

      const courierName = order.courierServiceName || "Unknown Courier";
      const uniqueManifestId = `MANIFEST-${Math.floor(
        100000 + Math.random() * 900000
      )}`;

      // Title
      doc.fontSize(18).text("Shipex India Manifest", { align: "center" });
      doc.moveDown(0.5);
      const currentDateTime = new Date().toLocaleString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      doc
        .fontSize(12)
        .text(`Generated on ${currentDateTime}`, { align: "center" });
      doc.moveDown(1);

      // Seller & Courier Details
      let yPosition = doc.y;
      doc
        .fontSize(11)
        .text(
          `Seller: ${order.pickupAddress?.contactName || "N/A"}`,
          30,
          yPosition
        );
      doc.text(`${courierName}`, 30, doc.y + 10);
      doc
        .fontSize(10)
        .text(`Manifest ID: ${uniqueManifestId}`, 400, yPosition, {
          align: "right",
        });
      doc.fontSize(10).text(`Total Shipments to Dispatch: 1`, 400, doc.y + 15, {
        align: "right",
      });
      doc.moveDown(3);

      // Table Header
      let tableTop = doc.y;
      let columnWidths = [50, 180, 50, 80, 150];

      const drawTableRow = (y, row) => {
        let x = 30;
        row.forEach((text, i) => {
          doc.text(text, x, y, { width: columnWidths[i], align: "center" });
          x += columnWidths[i];
        });
      };

      doc.font("Helvetica-Bold").fontSize(12);
      drawTableRow(tableTop, [
        "S.No",
        "AWD ID",
        "Order ID",
        "Content",
        "Barcode",
      ]);
      doc.moveDown(0.5);
      doc
        .moveTo(30, tableTop + 15)
        .lineTo(570, tableTop + 15)
        .stroke();
      doc.moveDown(0.5);
      tableTop += 25;

      // Generate barcode
      let product = order.productDetails ? order.productDetails[0] : {};
      let barcodePath = path.join(__dirname, `barcode_${order.awb_number}.png`);

      await new Promise((resolve, reject) => {
        bwipjs.toBuffer(
          {
            bcid: "code128",
            text: order.awb_number || "N/A",
            scale: 3,
            height: 10,
            textxalign: "center",
          },
          (err, png) => {
            if (err) {
              console.error("Error generating barcode:", err);
              reject(err);
            } else {
              fs.writeFileSync(barcodePath, png);
              resolve();
            }
          }
        );
      });

      // Draw barcode image
      const barcodeX = 420;
      const barcodeY = tableTop - 5;
      const barcodeWidth = 100;
      const barcodeHeight = 40;

      doc.image(barcodePath, barcodeX, barcodeY, {
        width: barcodeWidth,
        height: barcodeHeight,
      });

      // Draw AWB number below barcode
      doc
        .font("Helvetica")
        .fontSize(10)
        .text(
          order.awb_number || "N/A",
          barcodeX,
          barcodeY + barcodeHeight + 2,
          {
            width: barcodeWidth,
            align: "center",
          }
        );

      // Draw row content
      doc.font("Helvetica").fontSize(12);
      drawTableRow(tableTop, [
        "1",
        order.awb_number || "N/A",
        order.orderId || "N/A",
        product.name || "N/A",
        "",
      ]);

      tableTop += 50;
      doc.moveDown(2);
      // Signature Section
      doc.moveDown(2);
      doc
        .fontSize(12)
        .font("Helvetica-Bold")
        .text("To Be Filled By Delivery Surface Logistics Executive", {
          align: "center",
          indent: -400,
        });
      doc.moveDown(1);

      let leftX = 30;
      let rightX = 310;
      let signatureY = doc.y;

      doc.font("Helvetica").fontSize(10);
      doc.text(
        "Pickup Time:    ____________________________",
        leftX,
        signatureY,
        { width: 300 }
      );
      doc.text(
        "Total Items Picked:    ____________________",
        rightX,
        signatureY,
        { width: 300 }
      );
      signatureY += 25;

      doc.text(
        "FE Name:         ____________________________",
        leftX,
        signatureY,
        { width: 300 }
      );
      doc.text(
        "FE Phone:                ____________________________",
        rightX,
        signatureY,
        { width: 300 }
      );
      signatureY += 25;

      doc.text(
        "FE Signature:   ____________________________",
        leftX,
        signatureY,
        { width: 300 }
      );
      doc.text(
        "Seller Signature:       ____________________________",
        rightX,
        signatureY,
        { width: 300 }
      );
      doc.moveDown(2);

      doc.fontSize(10).text("This is a system-generated document", {
        align: "center",
        indent: -300,
      });

      doc.end();

      // Wait for PDF finish
      await new Promise((resolve) => {
        stream.on("finish", resolve);
      });

      // Upload to AWS S3
      const fileBuffer = fs.readFileSync(writablePath);
      const manifestKey = `manifests/${order.awb_number}_${Date.now()}.pdf`;

      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: manifestKey,
          Body: fileBuffer,
          ContentType: "application/pdf",
        })
      );

      // Generate presigned URL
      const signedCommand = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: manifestKey,
      });
      const manifestUrl = await getSignedUrl(s3, signedCommand, {
        expiresIn: 7 * 24 * 60 * 60,
      });

      // Save to DB
      order.manifest = manifestUrl;
      await order.save();

      // Cleanup
      try { if (fs.existsSync(writablePath)) fs.unlinkSync(writablePath); } catch (e) {}
      if (fs.existsSync(barcodePath)) {
        try { fs.unlinkSync(barcodePath); } catch (e) {}
      }

      manifestResults.push({
        awb: order.awb_number,
        manifest: manifestUrl,
        message: "Manifest generated and uploaded successfully",
      });
    }

    return res.json({
      success: true,
      message: "Manifest generation complete",
      results: manifestResults,
    });
  } catch (error) {
    console.error("Error generating manifest:", error);
    res
      .status(500)
      .json({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
  }
};

module.exports = generateManifest;
