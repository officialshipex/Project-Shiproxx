const mongoose = require("mongoose");
const User = require("../../models/User.model");
const Wallet = require("../../models/wallet");
const WalletTransaction = require("../../models/WalletTransaction.model");
const AllocateRole = require("../../models/allocateRoleSchema");
const Order = require("../../models/newOrder.model");
const weightDispreancy = require("../../WeightDispreancy/weightDispreancy.model");

const getAllTransactionHistory = async (req, res) => {
  try {
    const {
      userSearch,
      fromDate,
      toDate,
      status,
      page = 1,
      limit = 20,
      paymentId,
      transactionId,
    } = req.query;
    const userMatchStage = {};
    const transactionMatchStage = {};

    // --- Employee filtering logic ---
    let allocatedUserIds = null;
    if (req.employee && req.employee.employeeId) {
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      allocatedUserIds = allocations.map((a) => a.sellerMongoId.toString());
      if (allocatedUserIds.length === 0) {
        return res.json({
          total: 0,
          page: Number(page),
          limit: limit === "all" ? "all" : Number(limit),
          results: [],
        });
      }
      userMatchStage["_id"] = {
        $in: allocatedUserIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    // Search by ID, email, or name
    if (userSearch) {
      const regex = new RegExp(userSearch, "i");
      if (mongoose.Types.ObjectId.isValid(userSearch)) {
        userMatchStage["$or"] = [
          { _id: new mongoose.Types.ObjectId(userSearch) },
          { email: regex },
          { name: regex },
        ];
      } else {
        userMatchStage["$or"] = [{ email: regex }, { name: regex }];
      }
    }

    // Normalize dates
    if (fromDate && toDate) {
      const startDate = new Date(new Date(fromDate).setHours(0, 0, 0, 0));
      const endDate = new Date(new Date(toDate).setHours(23, 59, 59, 999));
      transactionMatchStage["wallet.walletHistory.date"] = {
        $gte: startDate,
        $lte: endDate,
      };
    }

    if (status) {
      transactionMatchStage["wallet.walletHistory.status"] = status;
    }

    if (paymentId) {
      transactionMatchStage["wallet.walletHistory.paymentDetails.paymentId"] =
        paymentId;
    }

    if (transactionId) {
      transactionMatchStage[
        "wallet.walletHistory.paymentDetails.transactionId"
      ] = transactionId;
    }

    const parsedLimit = limit === "all" ? 0 : Number(limit);
    const skip = (Number(page) - 1) * parsedLimit;

    const basePipeline = [
      { $match: { Wallet: { $ne: null }, ...userMatchStage } },
      {
        $lookup: {
          from: "wallets",
          localField: "Wallet",
          foreignField: "_id",
          as: "wallet",
        },
      },
      { $unwind: "$wallet" },
      { $unwind: "$wallet.walletHistory" },
      { $match: transactionMatchStage },
      {
        $project: {
          _id: "$wallet.walletHistory._id",
          user: {
            _id: "$_id",
            name: "$fullname",
            email: "$email",
            userId: "$userId",
            phoneNumber: "$phoneNumber",
          },
          amount: "$wallet.walletHistory.paymentDetails.amount",
          type: "$wallet.walletHistory.paymentDetails.type",
          date: "$wallet.walletHistory.date",
          paymentId: "$wallet.walletHistory.paymentDetails.paymentId",
          orderId: "$wallet.walletHistory.paymentDetails.orderId",
          transactionId: "$wallet.walletHistory.paymentDetails.transactionId",
          status: "$wallet.walletHistory.status",
        },
      },
      { $sort: { date: -1 } },
    ];

    // Execute both paginated results and total count
    const [results, totalResult] = await Promise.all([
      parsedLimit === 0
        ? User.aggregate(basePipeline)
        : User.aggregate([
          ...basePipeline,
          { $skip: skip },
          { $limit: parsedLimit },
        ]),

      User.aggregate([...basePipeline, { $count: "total" }]),
    ]);

    const total = totalResult[0]?.total || 0;

    return res.json({
      total,
      page: Number(page),
      limit: parsedLimit === 0 ? "all" : parsedLimit,
      results,
    });
  } catch (error) {
    console.error("Error in getAllTransactionHistory:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

const generateUniqueTransactionId = async () => {
  let transactionId, exists;
  do {
    transactionId =
      Date.now().toString().slice(-6) + Math.floor(1000 + Math.random() * 9000);

    // Check if any wallet has at least one walletHistory entry with this transactionId
    exists = await Wallet.exists({
      walletHistory: {
        $elemMatch: {
          "paymentDetails.transactionId": transactionId,
        },
      },
    });
  } while (exists);
  // console.log("trans", transactionId);
  return transactionId;
};

const addWalletHistory = async (req, res) => {
  try {
    const { userId, paymentId, orderId, amount } = req.body;
    // console.log("re", req.body);

    // 1. Validate required fields
    if (!userId || !paymentId || !orderId || amount == null) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    const status = "success"; // Assuming success for this example
    const userID = Number(userId);
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ message: "Invalid amount value" });
    }

    // 2. Find user
    const user = await User.findOne({ userId: userID });
    if (!user || !user.Wallet) {
      return res.status(404).json({ message: "User or Wallet not found" });
    }

    // 3. Fetch wallet
    const wallet = await Wallet.findById(user.Wallet).select("walletHistory balance");
    if (!wallet) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    // 4. Check if paymentId already exists
    const existingEntry = wallet.walletHistory.find(
      (entry) => entry.paymentDetails.paymentId === paymentId
    );
    if (existingEntry) {
      return res.status(409).json({ message: "Payment ID already exists" });
    }

    // 5. Generate unique 10-digit transactionId
    const transactionId = await generateUniqueTransactionId();

    // 6. Create wallet history entry
    const historyEntry = {
      paymentDetails: {
        paymentId,
        orderId,
        walletId: wallet._id,
        amount: numericAmount,
        transactionId,
      },
      status, // Assuming success for this example
    };

    // 7. Push history
    wallet.walletHistory.push(historyEntry);

    // 8. If successful, update balance and add transaction
    if (status === "success") {
      wallet.balance += numericAmount;

      await WalletTransaction.create({
        walletId: wallet._id,
        category: "credit",
        amount: Number(amount),
        balanceAfterTransaction: wallet.balance,
        description: `Recharge From Gateway(Razorpay)`,
        channelOrderId: orderId,
      });
    }

    await wallet.save();

    res.status(200).json({
      message: "Wallet history added successfully",
      transactionId,
      updatedBalance: wallet.balance,
    });
  } catch (err) {
    console.error("Error adding wallet history:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

const addPassbook = async (req, res) => {
  try {
    const {
      status,
      orderId,
      awbNumber,
      amount,
      description,
      transactionType,
      userId,
    } = req.body;
    // console.log("re", req.body);

    // Validate incoming fields
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    if (!amount) {
      return res.status(400).json({ error: "Amount is required" });
    }

    if (!transactionType) {
      return res.status(400).json({ error: "Transaction type is required" });
    }

    if (!["credit", "debit"].includes(transactionType)) {
      return res
        .status(400)
        .json({ error: "Transaction type must be 'credit' or 'debit'" });
    }
    if (!description) {
      return res.status(400).json({ error: "Description is required" });
    }

    const user = await User.findById(userId);
    if (!user || !user.Wallet) {
      return res.status(404).json({ error: "User or wallet not found" });
    }

    const walletId = user.Wallet;
    const wallet = await Wallet.findById(walletId).select("balance");
    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    // Generate unique 10-digit transaction ID
    // const transactionId = generateUniqueTransactionId();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) {
      return res.status(400).json({ error: "Amount must be a valid number" });
    }

    const currentBalance =
      typeof wallet.balance === "number" ? wallet.balance : 0;
    console.log("currentBalance", currentBalance);

    // Calculate new balance
    const newBalance =
      transactionType === "credit"
        ? currentBalance + parsedAmount
        : currentBalance - parsedAmount;
    console.log("new balance", newBalance);
    // Add to wallet history
    // wallet.walletHistory.push({
    //   paymentDetails: {
    //     orderId,
    //     description,
    //     walletId,
    //     amount: parseFloat(amount),
    //     transactionId,
    //   },
    //   status: status || "success",
    // });

    const suffix = transactionType === "credit" ? "Received" : "Applied";
    const finalDescription = `${description} ${suffix}`;

    await WalletTransaction.create({
      walletId: wallet._id,
      channelOrderId: orderId,
      category: transactionType,
      amount: parseFloat(amount),
      balanceAfterTransaction: newBalance,
      awb_number: awbNumber,
      description: finalDescription,
    });

    // Update wallet balance
    wallet.balance = newBalance;

    await wallet.save();

    return res
      .status(200)
      .json({ success: true, message: "Passbook updated successfully" });
  } catch (error) {
    console.error("addPassbook error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const walletUpdation = async (req, res) => {
  try {
    const { amount, description, awbNumber, userId, category } = req.body;

    // console.log("req data", req.body);
    const isCreditNote = description === "Credit Note";
    const iswalletToBank = description === "Wallet to bank";

    // ✅ Validate required fields
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    if (!isCreditNote && !iswalletToBank && !awbNumber) {
      return res.status(400).json({ error: "AWB Number is required" });
    }

    if (!description)
      return res.status(400).json({ error: "Description is required" });
    if (!amount) return res.status(400).json({ error: "Amount is required" });
    if (!category)
      return res.status(400).json({ error: "Category is required" });
    if (!["credit", "debit"].includes(category.toLowerCase())) {
      return res
        .status(400)
        .json({ error: "Category must be either 'credit' or 'debit'" });
    }

    // ✅ Find User
    const user = await User.findOne({ userId });
    if (!user || !user.Wallet) {
      return res.status(404).json({ error: "User or Wallet not found" });
    }

    // ✅ Find Wallet
    const wallet = await Wallet.findById(user.Wallet).select("balance");
    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    let existingTxn = null;

    if (!isCreditNote && !iswalletToBank) {
      existingTxn = await WalletTransaction.findOne(
        { walletId: wallet._id, awb_number: awbNumber }
      ).lean();

      if (!existingTxn) {
        return res.status(404).json({
          success: false,
          message: `No transaction found with AWB Number: ${awbNumber}`,
        });
      }
    }

    let order = null;

    if (!isCreditNote) {
      order = await Order.findOne({ awb_number: awbNumber });
    }

    // ===== Orders Validations =====
    if (
      (description === "COD Charges" ||
        description === "RTO Freight Charges") &&
      order.status !== "RTO Delivered"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "COD or RTO Freight Charges can only be applied when the order status is 'RTO Delivered'.",
      });
    }

    if (
      (description === "Shipment Lost Liability" ||
        description === "Shipment Damaged Liability") &&
      !["Lost", "Damaged", "RTO Lost", "RTO Damaged"].includes(order.status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Shipment liability can only be applied if the order status is 'Lost', 'Damaged', 'RTO Lost', or 'RTO Damaged'. Current status: ${order.status}.`,
      });
    }

    if (
      (description === "Shipment Lost Liability" ||
        description === "Shipment Damaged Liability") &&
      amount > 2000
    ) {
      return res.status(400).json({
        success: false,
        message: "Liability amount cannot exceed 2000.",
      });
    }

    if (
      description === "Weight Dispute Charges" &&
      order.status !== "Delivered"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Weight dispute charges can only be applied when the order status is 'Delivered'.",
      });
    }

    const dispute = await weightDispreancy.findOne({ awbNumber: awbNumber });

    if (
      description === "Weight Dispute Charges" &&
      category === "debit" &&
      dispute.status === "Accepted"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Weight dispute charges have already been debited for this order.",
      });
    }

    if (
      description === "Weight Dispute Charges" &&
      category === "credit" &&
      dispute.status === "new"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Weight dispute charges cannot be credited until the dispute is resolved.",
      });
    }

    // ✅ Normalize comparison
    const normalizedReqDesc = description.trim().toLowerCase();
    const normalizedCategory = category.trim().toLowerCase();

    // ✅ Duplicate prevention (DB desc INCLUDES req desc)
    const duplicateTxn = await WalletTransaction.findOne({
      walletId: wallet._id,
      ...(isCreditNote
        ? { awb_number: { $exists: false } }
        : { awb_number: awbNumber }),
      description: { $regex: normalizedReqDesc, $options: "i" },
      category: { $regex: `^${normalizedCategory}$`, $options: "i" },
    }).lean();

    if (duplicateTxn) {
      return res.status(409).json({
        success: false,
        message: `A ${category} transaction with description '${description}' already exists for AWB Number ${awbNumber}.`,
      });
    }

    // ✅ Add NEW transaction since duplicate not found
    const parsedAmount = parseFloat(amount);
    const currentBalance =
      typeof wallet.balance === "number" ? wallet.balance : 0;

    // ===============================
    // ✅ Wallet to Bank validation
    // ===============================
    if (iswalletToBank) {
      if (category.toLowerCase() !== "debit") {
        return res.status(400).json({
          success: false,
          message: "Wallet to bank transaction can only be a debit.",
        });
      }

      if (wallet.balance < parsedAmount) {
        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance for Wallet to Bank transfer.",
        });
      }
    }

    const newBalance =
      normalizedCategory === "credit"
        ? currentBalance + parsedAmount
        : currentBalance - parsedAmount;

    if (iswalletToBank && newBalance < 0) {
      return res.status(400).json({
        success: false,
        message: "Wallet balance cannot be negative.",
      });
    }
    let updatedCategory;
    if (category === "credit") {
      updatedCategory = "Received";
    } else {
      updatedCategory = "Applied";
    }

    await WalletTransaction.create({
      walletId: wallet._id,
      channelOrderId: order?.orderId || null,
      awb_number: isCreditNote ? null : awbNumber,
      description: `${description} ${updatedCategory}`,
      category,
      amount: parsedAmount,
      balanceAfterTransaction: newBalance,
    });

    wallet.balance = newBalance; // ✅ Update balance

    await wallet.save();

    return res.status(200).json({
      success: true,
      message: "Transaction recorded successfully.",
      balance: newBalance,
    });
  } catch (error) {
    console.error("walletUpdation error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// Node/Express controller
const searchAwb = async (req, res) => {
  // console.log("re",req.query)
  try {
    const { query } = req.query;
    if (!query || query.trim().length < 3) return res.json({ awbs: [] });
    // Example: Case-insensitive search by awbNumber
    const orders = await Order.find({
      awb_number: { $regex: query, $options: "i" },
    }).limit(10);
    // Return list as [{ awbNumber, orderId }]
    const awbs = orders.map((o) => ({
      awbNumber: o.awb_number,
      orderId: o.orderId,
    }));
    console.log("awb", awbs);
    res.json({ awbs });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch AWB list." });
  }
};

const reverseTransaction = async (req, res) => {
  try {
    const { transaction } = req.body;
    if (!transaction || !transaction.user || !transaction.awb_number) {
      return res.status(400).json({ error: "Invalid request data" });
    }

    const userId = transaction.user._id;
    const awbNumber = transaction.awb_number;
    const orderId = transaction.orderId;
    const amount = transaction.amount;
    const description = transaction.description;
    const category = transaction.category;

    // 1. Find user and wallet
    const user = await User.findById(userId);
    if (!user || !user.Wallet) {
      return res.status(404).json({ error: "User or wallet not found" });
    }

    const wallet = await Wallet.findById(user.Wallet).select("balance");
    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }
    const reversedDescription = getReversedDescription(description);
    // 2. Check if already reversed ("credit" transaction with this AWB number exists)
    const alreadyReversed = await WalletTransaction.exists({
      walletId: wallet._id,
      awb_number: awbNumber,
      category: "credit",
      description: reversedDescription,
    });
    if (alreadyReversed) {
      return res
        .status(400)
        .json({ error: "Amount already reversed for this AWB number." });
    }

    // 3. Find original transaction to get balance before reversal
    // (optional: for accurate balance if needed)
    const originalTxn = await WalletTransaction.findOne({
      walletId: wallet._id,
      awb_number: awbNumber,
      category: category,
      description: description,
    }).lean();
    if (!originalTxn) {
      return res
        .status(404)
        .json({ error: "Original debit transaction not found." });
    }

    // 4. Prepare new balance and add reversal transaction
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) {
      return res.status(400).json({ error: "Amount must be a valid number." });
    }

    const newBalance =
      (typeof wallet.balance === "number" ? wallet.balance : 0) + parsedAmount;

    await WalletTransaction.create({
      walletId: wallet._id,
      channelOrderId: orderId,
      category: "credit",
      amount: parsedAmount,
      balanceAfterTransaction: newBalance,
      awb_number: awbNumber,
      description: reversedDescription,
    });

    wallet.balance = newBalance;
    await wallet.save();

    return res
      .status(200)
      .json({ success: true, message: "Amount reversed successfully." });
  } catch (error) {
    console.error("reverseTransaction error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const getReversedDescription = (description) => {
  if (!description) return "";

  const words = description.trim().split(" ");
  const lastWord = words[words.length - 1];

  if (lastWord.toLowerCase() === "applied") {
    words[words.length - 1] = "Received";
  }

  return words.join(" ");
};

module.exports = {
  getAllTransactionHistory,
  addWalletHistory,
  addPassbook,
  walletUpdation,
  searchAwb,
  reverseTransaction,
};
