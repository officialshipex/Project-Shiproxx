const mongoose = require("mongoose");
const MisReport = require("./MisReport.model");
const Shipment = require("../models/newOrder.model");
const User = require("../models/User.model");
const ExcelJS = require("exceljs");
const { s3 } = require("../config/s3");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const transporter = require("../notification/configEmailpass");

exports.generateMisReport = async (req, res) => {
  try {
    const { reportType, dateFilterType, fromDate, toDate, email, userSearch } = req.body;
    const isAdminOrEmployee = req.user?.isAdmin || req.user?.adminTab || req.employee;

    let targetUserId = req.user?._id;
    if (isAdminOrEmployee && userSearch) {
      if (mongoose.Types.ObjectId.isValid(userSearch)) {
        targetUserId = new mongoose.Types.ObjectId(userSearch);
      } else {
        // If userSearch is passed as string, search User to find _id
        const userObj = await User.findOne({
          $or: [{ userId: Number(userSearch) || 0 }, { email: userSearch }]
        });
        if (userObj) {
          targetUserId = userObj._id;
        }
      }
    }

    if (!fromDate || !toDate) {
      return res.status(400).json({ success: false, message: "Date range is required." });
    }

    const reportEntry = new MisReport({
      userId: targetUserId,
      reportType,
      dateFilterType,
      fromDate: new Date(fromDate),
      toDate: new Date(toDate),
      email: email || "",
      status: "pending"
    });

    const protocol = req.protocol;
    const host = req.get("host");

    await reportEntry.save();

    // Immediately respond to UI
    res.status(200).json({
      success: true,
      message: "Report generation started.",
      data: reportEntry
    });

    // Run Excel generation in background
    setImmediate(async () => {
      let localFilePath = "";
      try {
        const start = new Date(fromDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);

        const orderQuery = { userId: targetUserId };

        if (reportType === "Delivered") {
          orderQuery.status = "Delivered";
        } else if (reportType === "RTO") {
          orderQuery.status = { $regex: /rto/i };
        } else if (reportType === "Canceled") {
          orderQuery.status = "Cancelled";
        } else if (reportType === "Pending Order") {
          orderQuery.status = { $nin: ["Delivered", "Cancelled", "RTO Delivered", "RTO"] };
        }

        if (dateFilterType === "Pickup Date") {
          orderQuery.invoiceDate = { $gte: start, $lte: end };
        } else {
          orderQuery.createdAt = { $gte: start, $lte: end };
        }

        const fs = require("fs");
        const path = require("path");
        const tempDir = path.join(__dirname, "../uploads");
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const fileName = `MIS_Report_${reportEntry._id}.xlsx`;
        localFilePath = path.join(tempDir, fileName);

        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
          filename: localFilePath,
          useStyles: true,
          useSharedStrings: true
        });

        const worksheet = workbook.addWorksheet("MIS Report");

        worksheet.columns = [
          { header: "User ID", key: "userId", width: 15 },
          { header: "Order ID", key: "orderId", width: 15 },
          { header: "AWB Number", key: "awb_number", width: 20 },
          { header: "Courier / Provider", key: "provider", width: 20 },
          { header: "Courier Service Name", key: "courierServiceName", width: 25 },
          { header: "Payment Method", key: "paymentMethod", width: 15 },
          { header: "Amount", key: "amount", width: 15 },
          { header: "Status", key: "status", width: 15 },
          { header: "Order Type", key: "orderType", width: 10 },
          { header: "AWB Assigned Date", key: "createdAt", width: 20 },
          { header: "Pickup Date", key: "pickupDate", width: 20 },
          { header: "Dead Weight (kg)", key: "deadWeight", width: 15 },
          { header: "Volumetric Dimensions", key: "volumetricDims", width: 20 },
          { header: "Applicable Weight (kg)", key: "applicableWeight", width: 18 },
          { header: "Product Details", key: "productDetails", width: 40 },
          { header: "Freight Charge", key: "freightCharge", width: 15 },
          { header: "COD Charge", key: "codCharge", width: 15 },
          { header: "GST Charge", key: "gstCharge", width: 15 },
          { header: "RTO Freight Charge", key: "rtoFreight", width: 15 },
          { header: "RTO GST Charge", key: "rtoGst", width: 15 },
          { header: "Total Shipping Charge", key: "totalShipping", width: 20 },
          { header: "Pickup City", key: "pickupCity", width: 15 },
          { header: "Pickup State", key: "pickupState", width: 15 },
          { header: "Pickup Pincode", key: "pickupPincode", width: 15 },
          { header: "Receiver Name", key: "receiverName", width: 20 },
          { header: "Receiver Phone", key: "receiverPhone", width: 20 },
          { header: "Receiver Email", key: "receiverEmail", width: 25 },
          { header: "Receiver Address", key: "receiverAddress", width: 40 },
          { header: "isNDR", key: "isNDR", width: 10 },
          { header: "NDR Reason", key: "ndrReason", width: 25 },
          { header: "NDR Reason Date", key: "ndrReasonDate", width: 20 },
          { header: "NDR History", key: "ndrHistory", width: 40 },
          { header: "isRTO", key: "isRTO", width: 10 }
        ];

        const headerRow = worksheet.getRow(1);
        headerRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF0CBB7D" } // Brand Green
          };
          cell.alignment = { vertical: "middle", horizontal: "center" };
        });
        headerRow.commit();

        const usersList = await User.find({}, { userId: 1 }).lean();
        const userMap = {};
        usersList.forEach(u => {
          userMap[u._id.toString()] = u.userId || "N/A";
        });

        const cursor = Shipment.find(orderQuery)
          .select("-tracking")
          .cursor();

        for await (const order of cursor) {
          const isNDR = (order.ndrHistory && order.ndrHistory.length > 0) || ["undelivered", "ndr"].includes(String(order.ndrStatus || '').toLowerCase()) ? "Yes" : "No";
          const isRTO = String(order.status || '').toLowerCase().includes("rto") ? "Yes" : "No";

          const productDetailsStr = order.productDetails && order.productDetails.length > 0
            ? order.productDetails.map(p => `${p.name || "N/A"} (SKU: ${p.sku || "N/A"}, Qty: ${p.quantity || 0}, Price: ${p.unitPrice || 0})`).join(" | ")
            : "N/A";

          const volumetricDimsStr = order.packageDetails?.volumetricWeight
            ? `${order.packageDetails.volumetricWeight.length || 0}x${order.packageDetails.volumetricWeight.width || 0}x${order.packageDetails.volumetricWeight.height || 0}`
            : "N/A";

          const ndrHistoryStr = order.ndrHistory && order.ndrHistory.length > 0
            ? order.ndrHistory.map((h, i) => {
                const actionsStr = h.actions && h.actions.length > 0
                  ? h.actions.map(a => `${a.action} by ${a.actionBy} (${a.remark || "No remark"})`).join(" -> ")
                  : "No actions";
                return `Entry ${i + 1}: ${actionsStr}`;
              }).join(" | ")
            : "N/A";

          worksheet.addRow({
            userId: userMap[order.userId?.toString()] || "N/A",
            orderId: order.orderId,
            awb_number: order.awb_number || "N/A",
            provider: order.provider || "N/A",
            courierServiceName: order.courierServiceName || "N/A",
            paymentMethod: order.paymentDetails?.method || "N/A",
            amount: order.paymentDetails?.amount || 0,
            status: order.status,
            orderType: order.orderType || "B2C",
            createdAt: order.createdAt ? new Date(order.createdAt).toLocaleDateString() : "N/A",
            pickupDate: order.invoiceDate ? new Date(order.invoiceDate).toLocaleDateString() : "N/A",
            deadWeight: order.packageDetails?.deadWeight || 0,
            volumetricDims: volumetricDimsStr,
            applicableWeight: order.packageDetails?.applicableWeight || 0,
            productDetails: productDetailsStr,
            freightCharge: order.priceBreakup?.freight || 0,
            codCharge: order.priceBreakup?.cod || 0,
            gstCharge: order.priceBreakup?.gst || 0,
            rtoFreight: order.priceBreakup?.rto?.freight || 0,
            rtoGst: order.priceBreakup?.rto?.gst || 0,
            totalShipping: order.priceBreakup?.total || 0,
            pickupCity: order.pickupAddress?.city || "N/A",
            pickupState: order.pickupAddress?.state || "N/A",
            pickupPincode: order.pickupAddress?.pinCode || "N/A",
            receiverName: "*****",
            receiverPhone: "*****",
            receiverEmail: "*****",
            receiverAddress: "*****",
            isNDR,
            ndrReason: order.ndrReason?.reason || "N/A",
            ndrReasonDate: order.ndrReason?.date ? new Date(order.ndrReason.date).toLocaleDateString() : "N/A",
            ndrHistory: ndrHistoryStr,
            isRTO
          }).commit();
        }

        await workbook.commit();

        const buffer = fs.readFileSync(localFilePath);
        const s3Key = `reports/${targetUserId}/MIS_Report_${reportEntry._id}.xlsx`;

        await s3.send(
          new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: s3Key,
            Body: buffer,
            ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          })
        );

        const downloadUrl = await getSignedUrl(s3,
          new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: s3Key,
          }),
          { expiresIn: 7 * 24 * 60 * 60 } // Link valid for 7 days
        );

        reportEntry.status = "completed";
        reportEntry.downloadUrl = downloadUrl;
        await reportEntry.save();

        if (email) {
          await transporter.sendMail({
            from: '"Shipex Team" <info@shipexindia.com>',
            to: email,
            subject: "Generated MIS Report",
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2>MIS Report Ready</h2>
                <p>Dear User,</p>
                <p>Your MIS Report has been successfully generated. You can download it directly from the link below or access it from your dashboard.</p>
                <p>
                  <a href="${downloadUrl}" style="background-color: #0CBB7D; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                    Download Report
                  </a>
                </p>
                <p>Thanks,<br/>Shipex Team</p>
              </div>
            `,
            attachments: [
              {
                filename: `MIS_Report_${new Date().toISOString().slice(0, 10)}.xlsx`,
                content: buffer
              }
            ]
          });
        }
      } catch (bgError) {
        console.error("Background report error:", bgError);
        reportEntry.status = "failed";
        await reportEntry.save();
      } finally {
        const fs = require("fs");
        if (localFilePath && fs.existsSync(localFilePath)) {
          try {
            fs.unlinkSync(localFilePath);
          } catch (unlinkErr) {
            console.error("Failed to delete temp file:", unlinkErr);
          }
        }
      }
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

exports.listMisReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { userSearch } = req.query;

    const isAdminOrEmployee = req.user?.isAdmin || req.user?.adminTab || req.employee;
    const query = {};

    if (isAdminOrEmployee) {
      if (userSearch) {
        if (mongoose.Types.ObjectId.isValid(userSearch)) {
          query.userId = new mongoose.Types.ObjectId(userSearch);
        } else {
          const userObj = await User.findOne({
            $or: [{ userId: Number(userSearch) || 0 }, { email: userSearch }]
          });
          if (userObj) {
            query.userId = userObj._id;
          } else {
            query.userId = new mongoose.Types.ObjectId(); // invalid Object ID to force empty results
          }
        }
      }
    } else {
      query.userId = req.user?._id;
    }

    const basePipeline = [
      { $match: query },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          reportType: 1,
          dateFilterType: 1,
          fromDate: 1,
          toDate: 1,
          email: 1,
          status: 1,
          downloadUrl: 1,
          createdAt: 1,
          user: {
            _id: "$user._id",
            userId: "$user.userId",
            fullname: "$user.fullname",
            email: "$user.email",
            phoneNumber: "$user.phoneNumber",
          }
        }
      },
      { $sort: { createdAt: -1 } }
    ];

    const [results, total] = await Promise.all([
      MisReport.aggregate([
        ...basePipeline,
        { $skip: skip },
        { $limit: limit }
      ]),
      MisReport.countDocuments(query)
    ]);

    res.status(200).json({ success: true, total, page, limit, results });
  } catch (error) {
    console.error("List reports error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};
