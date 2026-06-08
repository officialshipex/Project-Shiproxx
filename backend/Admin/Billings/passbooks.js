const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const AllocateRole = require("../../models/allocateRoleSchema");
const WalletTransaction = require("../../models/WalletTransaction.model");
const mongoose = require("mongoose");

const getAllPassbookTransactions = async (req, res) => {
  try {
    const {
      userSearch,
      fromDate,
      toDate,
      category,
      description,
      page = 1,
      limit = 20,
      awbNumber,
      orderId,
    } = req.query;

    const userMatchConditions = {};
    let filterByUser = false;

    // --- Employee filtering logic ---
    if (req.employee && req.employee.employeeId) {
      filterByUser = true;
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      }).lean();

      const allocatedUserIds = allocations.map((a) =>
        a.sellerMongoId.toString()
      );

      if (allocatedUserIds.length === 0) {
        return res.json({
          total: 0,
          page: Number(page),
          limit: limit === "all" ? "all" : Number(limit),
          results: [],
        });
      }

      userMatchConditions["_id"] = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // --- User search (id, email, name) ---
    if (userSearch) {
      filterByUser = true;
      const regex = new RegExp(userSearch, "i");
      if (mongoose.Types.ObjectId.isValid(userSearch)) {
        userMatchConditions["$or"] = [
          { _id: new mongoose.Types.ObjectId(userSearch) },
          { email: regex },
          { fullname: regex },
        ];
      } else {
        userMatchConditions["$or"] = [{ email: regex }, { fullname: regex }];
      }
    }

    // Determine wallet IDs if user filtering is active
    let matchedWalletIds = [];
    if (filterByUser) {
      const users = await User.find({ Wallet: { $ne: null }, ...userMatchConditions }, { Wallet: 1 }).lean();
      matchedWalletIds = users.map(u => u.Wallet);
      if (matchedWalletIds.length === 0) {
        return res.json({
          total: 0,
          page: Number(page),
          limit: limit === "all" ? "all" : Number(limit),
          results: [],
        });
      }
    }

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * parsedLimit;

    // --- Transaction match stage ---
    const txnMatchStage = {};
    if (filterByUser) {
      txnMatchStage["walletId"] = { $in: matchedWalletIds };
    }
    if (fromDate && toDate) {
      const startDate = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
      const endDate = new Date(new Date(toDate).setHours(23, 59, 59, 999));
      txnMatchStage["date"] = { $gte: startDate, $lte: endDate };
    }
    if (category) txnMatchStage["category"] = category;
    if (description) txnMatchStage["description"] = description;
    if (awbNumber) txnMatchStage["awb_number"] = awbNumber;
    if (orderId) txnMatchStage["channelOrderId"] = orderId;

    const pipeline = [
      { $match: txnMatchStage },
      { $sort: { date: -1 } },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            ...(parsedLimit > 0
              ? [{ $skip: skip }, { $limit: parsedLimit }]
              : []),
            {
              $lookup: {
                from: "users",
                localField: "walletId",
                foreignField: "Wallet",
                as: "userInfo",
              },
            },
            { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: "neworders",
                let: { awb: "$awb_number" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$awb_number", "$$awb"] },
                    },
                  },
                  { $project: { courierServiceName: 1, provider: 1, priceBreakup: 1, rateBreakup: 1, orderType: 1, _id: 0 } },
                  { $limit: 1 },
                ],
                as: "orderInfo",
              },
            },
            {
              $project: {
                user: {
                  _id: "$userInfo._id",
                  name: "$userInfo.fullname",
                  email: "$userInfo.email",
                  userId: "$userInfo.userId",
                  phoneNumber: "$userInfo.phoneNumber",
                },
                _id: { $toString: "$_id" },
                id: { $toString: "$_id" },
                category: "$category",
                amount: "$amount",
                balanceAfterTransaction: "$balanceAfterTransaction",
                date: "$date",
                awb_number: "$awb_number",
                orderId: "$channelOrderId",
                description: "$description",
                courierServiceName: {
                  $ifNull: [
                    { $arrayElemAt: ["$orderInfo.courierServiceName", 0] },
                    null,
                  ],
                },
                provider: {
                  $ifNull: [{ $arrayElemAt: ["$orderInfo.provider", 0] }, null],
                },
                priceBreakup: {
                  $ifNull: [
                    "$priceBreakup",
                    { $arrayElemAt: ["$orderInfo.priceBreakup", 0] },
                  ],
                },
                rateBreakup: {
                  $ifNull: [{ $arrayElemAt: ["$orderInfo.rateBreakup", 0] }, null],
                },
                orderType: {
                  $ifNull: [{ $arrayElemAt: ["$orderInfo.orderType", 0] }, null],
                },
              },
            },
          ],
        },
      },
    ];

    const result = await WalletTransaction.aggregate(pipeline).allowDiskUse(true);

    const total = result[0]?.metadata[0]?.total || 0;
    const totalPages = parsedLimit === 0 ? 1 : Math.ceil(total / parsedLimit);

    return res.json({
      total,
      totalPages,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results: result[0]?.data || [],
    });
  } catch (error) {
    console.error("Error in getAllPassbookTransactions:", error);
    return res.status(500).json({ message: "Server error" });
  }
};



const exportPassbook = async (req, res) => {
  try {
    const { transactionsId } = req.body;
    if (
      !transactionsId ||
      !Array.isArray(transactionsId) ||
      transactionsId.length === 0
    ) {
      return res
        .status(400)
        .json({ message: "transactionsId array is required" });
    }

    // Convert string IDs to ObjectId
    const objectIds = transactionsId
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    // Aggregate pipeline to fetch transactions matching given ids
    const pipeline = [
      { $match: { Wallet: { $ne: null } } },
      {
        $lookup: {
          from: "wallettransactions",
          localField: "Wallet",
          foreignField: "walletId",
          as: "txn",
        },
      },
      { $unwind: "$txn" },
      {
        $match: {
          "txn._id": { $in: objectIds },
        },
      },
      {
        $lookup: {
          from: "neworders",
          let: { awb: "$txn.awb_number" },
          pipeline: [
            { $match: { $expr: { $eq: ["$awb_number", "$$awb"] } } },
            {
              $project: {
                courierServiceName: 1,
                provider: 1,
                priceBreakup: 1,
                rateBreakup: 1,
                orderType: 1,
                _id: 0,
              },
            },
          ],
          as: "orderInfo",
        },
      },
      {
        $project: {
          _id: 0,
          user: {
            _id: "$_id",
            name: "$fullname",
            email: "$email",
            userId: "$userId",
            phoneNumber: "$phoneNumber",
          },
          id: "$txn._id",
          category: "$txn.category",
          amount: "$txn.amount",
          balanceAfterTransaction:
            "$txn.balanceAfterTransaction",
          date: "$txn.date",
          awb_number: "$txn.awb_number",
          orderId: "$txn.channelOrderId",
          description: "$txn.description",
          courierServiceName: {
            $arrayElemAt: ["$orderInfo.courierServiceName", 0],
          },
          provider: { $arrayElemAt: ["$orderInfo.provider", 0] },
          priceBreakup: {
            $ifNull: [
              "$txn.priceBreakup",
              { $arrayElemAt: ["$orderInfo.priceBreakup", 0] },
            ],
          },
          rateBreakup: { $arrayElemAt: ["$orderInfo.rateBreakup", 0] },
          orderType: { $arrayElemAt: ["$orderInfo.orderType", 0] },
        },
      },
      { $sort: { date: -1 } },
    ];

    const results = await User.aggregate(pipeline);

    if (!results || results.length === 0) {
      return res
        .status(404)
        .json({ message: "No transactions found for given IDs" });
    }

    // Build CSV content
    const csvData = results.map((transaction) => ({
      userId: transaction.user.userId,
      userName: transaction.user.name,
      Email: transaction.user.email,
      Category: transaction.category,
      Amount: transaction.amount,
      BalanceAfterTransaction: transaction.balanceAfterTransaction,
      Date: transaction.date.toISOString(),
      AWBNumber: transaction.awb_number || "",
      OrderId: transaction.orderId || "",
      Description: transaction.description || "",
      CourierServiceName: transaction.courierServiceName || "",
      Provider: transaction.provider || "",
    }));

    const csvHeaders = Object.keys(csvData[0]);
    const csvContent = [
      csvHeaders.join(","),
      ...csvData.map((row) =>
        csvHeaders
          .map((header) => `"${String(row[header]).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=passbook_export.csv"
    );
    return res.send(csvContent);
  } catch (error) {
    console.error("Error exporting passbook by IDs:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getAllPassbookTransactions, exportPassbook };
