const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const xlsx = require("xlsx");
const Order = require("../../../models/newOrder.model");
const { generateUniqueOrderIds } = require("../../../utils/generateUniqueOrderId");
const PickupAddress = require("../../../models/pickupAddress.model");
const File = require("../../../model/bulkOrderFiles.model");

const downloadSampleExcelB2B = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("B2B Bulk Orders");

    /* ===============================
       DEFINE COLUMNS
    =============================== */
    worksheet.columns = [
      /* ===============================
         RECEIVER DETAILS (MANDATORY)
      =============================== */
      { header: "*Receiver Contact Name", key: "receiver_contact", width: 25 },
      { header: "*Receiver Email", key: "receiver_email", width: 30 },
      { header: "*Receiver Phone Number", key: "receiver_phone", width: 20 },
      { header: "*Receiver Address", key: "receiver_address", width: 40 },
      { header: "*Receiver Pin Code", key: "receiver_pincode", width: 15 },
      { header: "*Receiver City", key: "receiver_city", width: 20 },
      { header: "*Receiver State", key: "receiver_state", width: 20 },

      /* ===============================
         PACKAGE 1 (MANDATORY)
      =============================== */
      { header: "*Pkg 1 Boxes", key: "pkg1_boxes", width: 14 },
      { header: "*Pkg 1 Weight/Box (kg)", key: "pkg1_weight", width: 18 },
      { header: "*Pkg 1 Length (cm)", key: "pkg1_length", width: 16 },
      { header: "*Pkg 1 Width (cm)", key: "pkg1_width", width: 16 },
      { header: "*Pkg 1 Height (cm)", key: "pkg1_height", width: 16 },

      /* ===============================
         PACKAGE 2 (OPTIONAL)
      =============================== */
      { header: "Pkg 2 Boxes (Optional)", key: "pkg2_boxes", width: 16 },
      { header: "Pkg 2 Weight/Box (kg)", key: "pkg2_weight", width: 20 },
      { header: "Pkg 2 Length (cm)", key: "pkg2_length", width: 18 },
      { header: "Pkg 2 Width (cm)", key: "pkg2_width", width: 18 },
      { header: "Pkg 2 Height (cm)", key: "pkg2_height", width: 18 },

      /* ===============================
         PACKAGE 3 (OPTIONAL)
      =============================== */
      { header: "Pkg 3 Boxes (Optional)", key: "pkg3_boxes", width: 16 },
      { header: "Pkg 3 Weight/Box (kg)", key: "pkg3_weight", width: 20 },
      { header: "Pkg 3 Length (cm)", key: "pkg3_length", width: 18 },
      { header: "Pkg 3 Width (cm)", key: "pkg3_width", width: 18 },
      { header: "Pkg 3 Height (cm)", key: "pkg3_height", width: 18 },

      /* ===============================
         PRODUCT 1 (MANDATORY)
      =============================== */
      { header: "*Product 1 Name", key: "product1_name", width: 30 },
      { header: "Product 1 SKU (Optional)", key: "product1_sku", width: 24 },
      { header: "Product 1 HSN (Optional)", key: "product1_hsn", width: 20 },
      {
        header: "Product 1 Discount (Optional)",
        key: "product1_discount",
        width: 22,
      },
      { header: "Product 1 Tax (Optional)", key: "product1_tax", width: 18 },
      { header: "*Product 1 Quantity", key: "product1_quantity", width: 22 },
      { header: "*Product 1 Unit Price", key: "product1_price", width: 22 },

      /* ===============================
         PRODUCT 2 (OPTIONAL)
      =============================== */
      { header: "Product 2 Name (Optional)", key: "product2_name", width: 30 },
      { header: "Product 2 SKU (Optional)", key: "product2_sku", width: 24 },
      { header: "Product 2 HSN (Optional)", key: "product2_hsn", width: 20 },
      {
        header: "Product 2 Discount (Optional)",
        key: "product2_discount",
        width: 22,
      },
      { header: "Product 2 Tax (Optional)", key: "product2_tax", width: 18 },
      {
        header: "Product 2 Quantity (Optional)",
        key: "product2_quantity",
        width: 22,
      },
      {
        header: "Product 2 Unit Price (Optional)",
        key: "product2_price",
        width: 22,
      },

      /* ===============================
         PAYMENT
      =============================== */
      { header: "*Method (COD/Prepaid)", key: "method", width: 22 },
      {
        header: "*Rov Type (ROV Owner/ROV Carrier)",
        key: "rovType",
        width: 26,
      },

      /* ===============================
         OPTIONAL B2B FIELDS
      =============================== */
      { header: "GSTIN (Optional)", key: "gstin", width: 26 },
      { header: "E-Waybill (Optional)", key: "ewaybill", width: 26 },
    ];

    /* ===============================
       SAMPLE ROW
    =============================== */
    worksheet.addRow({
      receiver_contact: "Factory Manager",
      receiver_email: "factory@example.com",
      receiver_phone: "9876543210",
      receiver_address: "Industrial Area Phase 2",
      receiver_pincode: "110042",
      receiver_city: "Delhi",
      receiver_state: "Delhi",

      // Mandatory Package 1
      pkg1_boxes: 2,
      pkg1_weight: 25,
      pkg1_length: 60,
      pkg1_width: 40,
      pkg1_height: 45,

      // Optional Package 2
      pkg2_boxes: 1,
      pkg2_weight: 30,
      pkg2_length: 70,
      pkg2_width: 45,
      pkg2_height: 50,

      // Optional Package 3 (left empty)

      // Mandatory Product 1
      product1_name: "Steel Rods",
      product1_quantity: 50,
      product1_price: 1200,
      product1_sku: "STL-ROD-01",
      product1_hsn: "721420",
      product1_discount: "5",
      product1_tax: "18",

      // Optional Product 2
      product2_name: "Iron Sheets",
      product2_quantity: 30,
      product2_price: 1800,

      method: "Prepaid",
      gstin: "27ABCDE1234F1Z5",
      ewaybill: "181012345678",
    });

    /* ===============================
       HEADER STYLING
    =============================== */
    worksheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    /* ===============================
       DOWNLOAD
    =============================== */
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=b2b_bulk_sample.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("B2B Sample Excel Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate B2B sample Excel",
      error: error.message,
    });
  }
};

/* ===============================
   EXCEL PARSER
================================ */
function parseExcel(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet);
}

/* ===============================
   B2B BULK ORDER CONTROLLER
================================ */
const bulkOrderB2B = async (req, res) => {
  try {
    const userId = req.user._id;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    /* ===============================
       SAVE FILE META
    =============================== */
    const fileData = new File({
      filename: req.file.filename,
      date: new Date(),
      status: "Processing",
    });
    await fileData.save();

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (![".xlsx", ".xls"].includes(ext)) {
      try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: "Unsupported file format" });
    }

    const rows = parseExcel(req.file.path);
    if (!rows.length) {
      try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: "Excel file is empty" });
    }

    /* ===============================
       DEFAULT PICKUP ADDRESS
    =============================== */
    const defaultPickup = await PickupAddress.findOne({
      userId,
      isPrimary: true,
    });

    const pickupAddress = defaultPickup
      ? defaultPickup.pickupAddress
      : {
          contactName: "Default",
          email: "default@example.com",
          phoneNumber: "0000000000",
          address: "Default Address",
          pinCode: "000000",
          city: "Default City",
          state: "Default State",
        };

    /* ===============================
       BUILD ORDERS
    =============================== */
    const orderDocs = [];
    const rowErrors = [];

    // Pre-generate a batch of unique order IDs for all rows
    const uniqueOrderIds = await generateUniqueOrderIds(rows.length);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // Excel row (header at row 1)

      try {
        /* ===============================
           ORDER ID
        =============================== */
        const orderId = uniqueOrderIds[i];

        const compositeOrderId = `${userId}-${orderId}`;

        /* ===============================
           PRODUCTS VALIDATION
        =============================== */
        if (
          !row["*Product 1 Name"] ||
          !row["*Product 1 Quantity"] ||
          !row["*Product 1 Unit Price"]
        ) {
          throw new Error(
            "Product 1 Name, Quantity, and Unit Price are mandatory"
          );
        }

        const productDetails = [
          {
            id: 1,
            name: row["*Product 1 Name"],
            quantity: Number(row["*Product 1 Quantity"]),
            unitPrice: Number(row["*Product 1 Unit Price"]),
            sku: row["Product 1 SKU (Optional)"] || "",
            hsn: row["Product 1 HSN (Optional)"] || "",
            discount: row["Product 1 Discount (Optional)"] || "",
            tax: row["Product 1 Tax (Optional)"] || "",
          },
        ];

        if (
          row["Product 2 Name (Optional)"] &&
          row["Product 2 Quantity (Optional)"] &&
          row["Product 2 Unit Price (Optional)"]
        ) {
          productDetails.push({
            id: 2,
            name: row["Product 2 Name (Optional)"],
            quantity: Number(row["Product 2 Quantity (Optional)"]),
            unitPrice: Number(row["Product 2 Unit Price (Optional)"]),
            sku: row["Product 2 SKU (Optional)"] || "",
            hsn: row["Product 2 HSN (Optional)"] || "",
            discount: row["Product 2 Discount (Optional)"] || "",
            tax: row["Product 2 Tax (Optional)"] || "",
          });
        }

        /* ===============================
           PACKAGES VALIDATION
        =============================== */
        if (
          !row["*Pkg 1 Boxes"] ||
          !row["*Pkg 1 Weight/Box (kg)"] ||
          !row["*Pkg 1 Length (cm)"] ||
          !row["*Pkg 1 Width (cm)"] ||
          !row["*Pkg 1 Height (cm)"]
        ) {
          throw new Error("Package 1 details are mandatory");
        }

        const packages = [
          {
            id: 1,
            noOfBox: Number(row["*Pkg 1 Boxes"]),
            weightPerBox: Number(row["*Pkg 1 Weight/Box (kg)"]),
            length: Number(row["*Pkg 1 Length (cm)"]),
            width: Number(row["*Pkg 1 Width (cm)"]),
            height: Number(row["*Pkg 1 Height (cm)"]),
          },
        ];

        if (row["Pkg 2 Boxes (Optional)"]) {
          packages.push({
            id: 2,
            noOfBox: Number(row["Pkg 2 Boxes (Optional)"]),
            weightPerBox: Number(row["Pkg 2 Weight/Box (kg)"]),
            length: Number(row["Pkg 2 Length (cm)"]),
            width: Number(row["Pkg 2 Width (cm)"]),
            height: Number(row["Pkg 2 Height (cm)"]),
          });
        }

        if (row["Pkg 3 Boxes (Optional)"]) {
          packages.push({
            id: 3,
            noOfBox: Number(row["Pkg 3 Boxes (Optional)"]),
            weightPerBox: Number(row["Pkg 3 Weight/Box (kg)"]),
            length: Number(row["Pkg 3 Length (cm)"]),
            width: Number(row["Pkg 3 Width (cm)"]),
            height: Number(row["Pkg 3 Height (cm)"]),
          });
        }

        /* ===============================
           TOTAL AMOUNT
        =============================== */
        const amount = productDetails.reduce(
          (sum, p) => sum + p.quantity * p.unitPrice,
          0
        );

        /* ===============================
           WEIGHT CALCULATION
        =============================== */
        const VOLUMETRIC_DIVISOR = 5000;

        let totalActualWeight = 0;
        let totalVolumetricWeight = 0;

        for (const pkg of packages) {
          const actualWeight = Number(pkg.weightPerBox) * Number(pkg.noOfBox);

          const volumetricWeight =
            (Number(pkg.length) *
              Number(pkg.width) *
              Number(pkg.height) *
              Number(pkg.noOfBox)) /
            VOLUMETRIC_DIVISOR;

          totalActualWeight += actualWeight;
          totalVolumetricWeight += volumetricWeight;
        }
        // console.log("actual weight", totalActualWeight);
        // console.log("volumetric", totalVolumetricWeight);

        const applicableWeight = Math.max(
          totalActualWeight,
          totalVolumetricWeight
        );

        /* ===============================
           ORDER DOC
        =============================== */
        orderDocs.push({
          userId,
          orderId,
          orderType: "B2B",
          compositeOrderId,
          pickupAddress,
          receiverAddress: {
            contactName: row["*Receiver Contact Name"],
            email: row["*Receiver Email"],
            phoneNumber: row["*Receiver Phone Number"],
            address: row["*Receiver Address"],
            pinCode: row["*Receiver Pin Code"],
            city: row["*Receiver City"],
            state: row["*Receiver State"],
          },
          paymentDetails: {
            method: row["*Method (COD/Prepaid)"].trim(),
            amount,
          },
          rovType: row["*Rov Type (ROV Owner/ROV Carrier)"]?.trim(),
          productDetails,
          B2BPackageDetails: {
            applicableWeight: applicableWeight.toFixed(2),
            volumetricWeight: totalVolumetricWeight.toFixed(2),
            packages,
          },
          otherDetails: {
            gstin: row["GSTIN (Optional)"] || "",
            ewaybill: row["E-Waybill (Optional)"] || "",
          },
          channel: "custom",
          status: "new",
        });
      } catch (err) {
        rowErrors.push({
          row: rowNumber,
          message: err.message,
        });
      }
    }

    /* ===============================
       INSERT VALID ORDERS
    =============================== */
    if (orderDocs.length) {
      await Order.insertMany(orderDocs);
    }

    fileData.status = rowErrors.length ? "Partial" : "Completed";
    fileData.noOfOrders = rows.length;
    fileData.successfullyUploaded = orderDocs.length;
    await fileData.save();

    fs.unlinkSync(req.file.path);

    return res.status(rowErrors.length ? 207 : 200).json({
      message:
        rowErrors.length === 0
          ? "B2B bulk orders uploaded successfully"
          : "Bulk upload completed with some errors",

      totalRows: rows.length,
      successCount: orderDocs.length,
      failedCount: rowErrors.length,
      errors: rowErrors,
      file: fileData,
    });
  } catch (error) {
    console.error("B2B Bulk Upload Error:", error);
    if (req.file && req.file.path) {
      try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (e) {}
    }
    return res.status(500).json({
      error: error.message || "Failed to process B2B bulk upload",
    });
  }
};

module.exports = { downloadSampleExcelB2B, bulkOrderB2B };
