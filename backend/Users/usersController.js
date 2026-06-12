const jwt = require("jsonwebtoken");
const User = require("../models/User.model");
const Plan = require("../models/Plan.model");
const B2BPlan = require("../B2B/models/plan.model");
const mongoose = require("mongoose");
const Account = require("../models/BankAccount.model");
const Aadhar = require("../models/Aadhaar.model");
const Pan = require("../models/Pan.model");
const Gst = require("../models/Gstin.model");
const CodPlans = require("../COD/codPan.model");
const AllocateRole = require("../models/allocateRoleSchema");
const Order = require("../models/newOrder.model");
const BillingAddress = require("../models/billingInfo.model");
const { generateKeySync } = require("crypto");
const Wallet = require("../models/wallet");
const WalletTransaction = require("../models/WalletTransaction.model");
const KamDetails = require("../models/KamDetails.model");
const ActivityLog = require("../models/ActivityLog.model");

const refundFreightIfSingleDebit = async () => {
  try {
    console.log("🚀 Running Refund Freight Batch...");

    // 1️⃣ Define date filter: shipmentCreatedAt before 20 Nov 2025
    const cutoffDate = new Date("2025-11-01T00:00:00.000Z");

    // 2️⃣ Fetch all eligible orders in bulk
    const orders = await Order.find({
      shipmentCreatedAt: { $lt: cutoffDate },
      // status: { $in: ["Ready To Ship", "Booked", "Not Picked"] },
      status: { $in: ["In-transit"] },
    });

    if (!orders.length) {
      console.log("ℹ No eligible orders found.");
      return;
    }

    console.log(`📦 Found ${orders.length} eligible orders.`);

    for (const order of orders) {
      const orderId = order.orderId;
      const awb = order.awb_number;

      console.log(`\n➡ Processing order ${orderId} (AWB: ${awb})`);

      // 3️⃣ Fetch User + Wallet
      const user = await User.findById(order.userId);
      if (!user || !user.Wallet) {
        console.log("❌ User or Wallet missing → Skipping.");
        continue;
      }

      const wallet = await Wallet.findById(user.Wallet).select("balance");
      if (!wallet) {
        console.log("❌ Wallet not found → Skipping.");
        continue;
      }

      // 4️⃣ Get wallet transactions for this AWB
      const walletTxns = await WalletTransaction.find({ walletId: wallet._id, awb_number: awb }).lean();

      // ---------------------------------------------------------
      // ⭐ CASE A → TWO transactions → Cancel Order + mark txns
      // ---------------------------------------------------------
      if (walletTxns.length === 2) {
        console.log(`⚠ Two txns found for ${awb}. Marking CANCELLED.`);

        order.status = "Cancelled";

        await WalletTransaction.updateMany(
          { walletId: wallet._id, awb_number: awb },
          { $set: { transactionStatus: "Cancelled" } }
        ).catch(err => console.error("⚠️ WalletTransaction status update failed in usersController:", err.message));

        await order.save();
        console.log("✔ Order + Wallet transactions updated.");
        continue;
      }

      // ---------------------------------------------------------
      // ⭐ CASE B → One DEBIT → Add CREDIT (refund freight)
      // ---------------------------------------------------------
      if (walletTxns.length === 1 && walletTxns[0].category === "debit") {
        const refundAmount = Number(order.totalFreightCharges || 0);

        if (refundAmount <= 0) {
          console.log("❌ Invalid totalFreightCharges → Skipping.");
          continue;
        }

        const newBalance = wallet.balance + refundAmount;

        // Add credit entry
    order.status = "Cancelled";

    wallet.balance = newBalance;

    await WalletTransaction.create({
          walletId: wallet._id,
          channelOrderId: orderId,
          category: "credit",
          amount: refundAmount,
          balanceAfterTransaction: newBalance,
          awb_number: awb,
          description: "Freight Charges Received",
        }).catch(err => console.error("⚠️ WalletTransaction dual-write failed in usersController:", err.message));

        await wallet.save();
        await order.save();
        console.log(`✔ Credited ₹${refundAmount} for AWB ${awb}.`);
        console.log(`💰 New Balance: ₹${newBalance}`);
        continue;
      }

      // ---------------------------------------------------------
      // ⭐ CASE C → No action
      // ---------------------------------------------------------
      console.log(
        `ℹ No action for AWB ${awb}. Txn count: ${walletTxns.length}`
      );
    }

    console.log("\n🏁 Freight Refund Batch Completed.");
  } catch (error) {
    console.error("❌ Error in refundFreightIfSingleDebit:", error.message);
  }
};

// refundFreightIfSingleDebit()

const checkGstForUser = async (userIdToFind = 40344) => {
  try {
    const user = await User.findOne({ userId: userIdToFind }).populate("Wallet");

    if (!user) {
      console.log(`User with userId ${userIdToFind} not found.`);
      return;
    }

    const wallet = user.Wallet;
    const walletTxns = await WalletTransaction.find({ walletId: wallet._id }).lean();
    if (!walletTxns || walletTxns.length === 0) {
      console.log(`No wallet or transactions found for user ${userIdToFind}.`);
      return;
    }

    let gstNotChargedOrders = [];
    let totalMissingGstSum = 0;

    console.log(`Checking transactions for user: ${user.fullname} (ID: ${userIdToFind})`);

    for (const transaction of walletTxns) {
      if (transaction.category === "debit") {
        let priceBreakup = transaction.priceBreakup;

        if (!priceBreakup && transaction.awb_number) {
          const order = await Order.findOne({ awb_number: transaction.awb_number });
          if (order && order.priceBreakup) {
            priceBreakup = order.priceBreakup;
          }
        }

        const gst = parseFloat(priceBreakup?.gst) || 0;

        if (gst === 0) {
          // Calculate what the GST should have been (18%)
          // Try to get base from priceBreakup, otherwise use transaction amount
          const baseAmount = (parseFloat(priceBreakup?.freight) || 0) + (parseFloat(priceBreakup?.cod) || 0);
          const calculationBase = baseAmount > 0 ? baseAmount : transaction.amount;
          const missingGst = calculationBase * 0.18;
          
          totalMissingGstSum += missingGst;

          gstNotChargedOrders.push({
            orderId: transaction.channelOrderId || "N/A",
            awb: transaction.awb_number || "N/A",
            gstAmount: gst,
            calculatedMissingGst: missingGst.toFixed(2),
            description: transaction.description,
            date: transaction.date
          });
        }
      }
    }

    console.log("\n--- Orders where GST was NOT charged ---");
    if (gstNotChargedOrders.length === 0) {
      console.log("None found.");
    } else {
      gstNotChargedOrders.forEach(order => {
        console.log(`OrderId: ${order.orderId}, AWB: ${order.awb}, Calculated Missing GST: ${order.calculatedMissingGst}, Date: ${order.date}`);
      });
    }

    console.log("\n--- Summary ---");
    console.log(`Total orders with 0 GST: ${gstNotChargedOrders.length}`);
    console.log(`Sum of missing GST for these orders: ${totalMissingGstSum.toFixed(2)}`);
    console.log("-------------------------------\n");
    console.log("-------------------------------\n");

  } catch (error) {
    console.error("Error in checkGstForUser:", error);
  }
};

// checkGstForUser();

const getUsers = async (req, res) => {
  try {
    let allUsers = [];
    // If employee, filter users by allocations
    if (req.employee && req.employee.employeeId) {
      // Get allocations for this employee
      const allocations = await AllocateRole.find({
        employeeId: req.employee.employeeId,
      });
      const sellerMongoIds = allocations.map((a) => a.sellerMongoId);
      // Fetch only users whose _id is in sellerMongoIds
      allUsers = await User.find({
        _id: { $in: sellerMongoIds },
        kycDone: true,
      });
    } else {
      // Admin: get all users as before
      allUsers = await User.find({ kycDone: true });
    }

    const isSeller = allUsers.some(
      (user) => user._id.toString() === req.user?.id
    );

    res.status(201).json({
      success: true,
      sellers: allUsers.map((user) => ({
        userId: user.userId,
        id: user._id,
        name: `${user.fullname}`,
        fullname: user.fullname,
        email: user.email,
        phoneNumber: user.phoneNumber,
        company: user.company,
        kycStatus: user.kycDone,
        // Add any other fields you want to keep for the frontend
      })),
      isSeller,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
};

const getAllUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit,
      search = "",
      kycStatus,
      rateCard,
      balanceType,
      id,
      userId,
    } = req.query;

    const parsedLimit = limit === "All" || !limit ? null : Number(limit);
    const skip = parsedLimit ? (Number(page) - 1) * parsedLimit : 0;

    const query = {};

    // --- 🔍 Filter Handling ---
    if (id && id.trim() !== "") {
      query._id = new mongoose.Types.ObjectId(id.trim());
    } else if (userId && userId.trim() !== "") {
      query.userId = Number(userId.trim());
    } else if (search && search.trim() !== "") {
      const trimmedSearch = search.trim();
      query.$or = [
        { userId: { $regex: trimmedSearch, $options: "i" } },
        { fullname: { $regex: trimmedSearch, $options: "i" } },
        { email: { $regex: trimmedSearch, $options: "i" } },
        { phoneNumber: { $regex: trimmedSearch, $options: "i" } },
      ];
    }

    if (kycStatus === "verified") query.kycDone = true;
    if (kycStatus === "pending") query.kycDone = false;

    // --- 👨‍💼 Role-based filtering ---
    if (req.employee?.employeeId) {
      const allocations = await AllocateRole.find(
        { employeeId: String(req.employee.employeeId) },
        { sellerMongoId: 1 }
      ).lean();

      const sellerMongoIds = allocations
        .map((a) => a.sellerMongoId)
        .filter(Boolean)
        .map((id) => new mongoose.Types.ObjectId(id));

      if (sellerMongoIds.length > 0) {
        query._id = { $in: sellerMongoIds };
      } else {
        return res.status(200).json({
          success: true,
          userIds: [],
          userDetails: [],
          verifiedKycCount: 0,
          pendingKycCount: 0,
          currentPage: Number(page),
          totalPages: 0,
          totalCount: 0,
        });
      }
    }

    // --- 🧠 Optimize with projection ---
    const projection = {
      userId: 1,
      fullname: 1,
      email: 1,
      phoneNumber: 1,
      company: 1,
      kycDone: 1,
      creditLimit: 1,
      createdAt: 1,
      lastLogin: 1,
      isBlocked: 1,
      Wallet: 1,
    };

    // --- ⚙️ Parallel fetching of all base data ---
    const [users, verifiedKycCount, pendingKycCount] = await Promise.all([
      User.find(query, projection).populate("Wallet", "balance").lean(),
      User.countDocuments({ ...query, kycDone: true }),
      User.countDocuments({ ...query, kycDone: false }),
    ]);

    if (users.length === 0) {
      return res.status(200).json({
        success: true,
        userIds: [],
        userDetails: [],
        verifiedKycCount,
        pendingKycCount,
        currentPage: Number(page),
        totalPages: 0,
        totalCount: 0,
      });
    }

    const userIds = users.map((u) => u._id);

    // --- 🧩 Fetch related data in parallel ---
    const [plans, codPlans, accounts, aadhars, pans, gsts, orderStats] =
      await Promise.all([
        Plan.find(
          { userId: { $in: userIds } },
          { userId: 1, planName: 1 }
        ).lean(),
        CodPlans.find(
          { user: { $in: userIds } },
          { user: 1, planName: 1 }
        ).lean(),
        Account.find(
          { user: { $in: userIds } },
          {
            user: 1,
            nameAtBank: 1,
            accountNumber: 1,
            ifsc: 1,
            bank: 1,
            branch: 1,
          }
        ).lean(),
        Aadhar.find(
          { user: { $in: userIds } },
          { user: 1, aadhaarNumber: 1, name: 1, state: 1, address: 1 }
        ).lean(),
        Pan.find(
          { user: { $in: userIds } },
          { user: 1, panNumber: 1, nameProvided: 1, pan: 1, panRefId: 1 }
        ).lean(),
        Gst.find(
          { user: { $in: userIds } },
          { user: 1, gstin: 1, address: 1, pincode: 1, state: 1, city: 1 }
        ).lean(),
        Order.aggregate([
          { $match: { userId: { $in: userIds } } },
          {
            $group: {
              _id: "$userId",
              orderCount: { $sum: 1 },
              lastOrderDate: { $max: "$createdAt" },
            },
          },
        ]),
      ]);

    // --- 🗺️ Build maps for quick access ---
    const planMap = new Map(plans.map((p) => [String(p.userId), p]));
    const codMap = new Map(codPlans.map((p) => [String(p.user), p]));
    const accountMap = new Map(accounts.map((a) => [String(a.user), a]));
    const aadharMap = new Map(aadhars.map((a) => [String(a.user), a]));
    const panMap = new Map(pans.map((p) => [String(p.user), p]));
    const gstMap = new Map(gsts.map((g) => [String(g.user), g]));
    const orderStatsMap = new Map(orderStats.map((s) => [String(s._id), s]));

    // --- ⚡ Filter + Paginate efficiently ---
    const filteredUsers = users.filter((user) => {
      const walletBalance = user.Wallet?.balance || 0;

      if (balanceType === "positive" && walletBalance < 0) return false;
      if (balanceType === "negative" && walletBalance >= 0) return false;

      const plan = planMap.get(String(user._id));
      if (
        rateCard &&
        plan?.planName?.toLowerCase() !== rateCard.toLowerCase()
      ) {
        return false;
      }

      return true;
    });

    const totalCount = filteredUsers.length;
    const totalPages = parsedLimit ? Math.ceil(totalCount / parsedLimit) : 1;
    const paginatedUsers = parsedLimit
      ? filteredUsers.slice(skip, skip + parsedLimit)
      : filteredUsers;

    // --- 🧾 Construct final response ---
    const userDetails = paginatedUsers.map((user) => {
      const uid = String(user._id);
      const walletBalance = user.Wallet?.balance || 0;
      const plan = planMap.get(uid);
      const stats = orderStatsMap.get(uid);

      return {
        id: user._id,
        userId: user.userId,
        fullname: user.fullname,
        email: user.email,
        isBlocked: user.isBlocked,
        lastLogin: user.lastLogin,
        phoneNumber: user.phoneNumber,
        company: user.company,
        kycStatus: user.kycDone,
        walletAmount: walletBalance,
        creditLimit: user.creditLimit || 0,
        rateCard: plan?.planName || "N/A",
        codPlan: codMap.get(uid)?.planName || "N/A",
        createdAt: user.createdAt,
        orderCount: stats?.orderCount || 0,
        lastOrderDate: stats?.lastOrderDate || null,
        accountDetails: (() => {
          const acc = accountMap.get(uid);
          if (!acc) return null;
          return {
            beneficiaryName: acc.nameAtBank,
            accountNumber: acc.accountNumber,
            ifscCode: acc.ifsc,
            bankName: acc.bank,
            branchName: acc.branch,
          };
        })(),
        aadharDetails: (() => {
          const a = aadharMap.get(uid);
          if (!a) return null;
          return {
            aadharNumber: a.aadhaarNumber,
            nameOnAadhar: a.name,
            state: a.state,
            address: a.address,
          };
        })(),
        panDetails: (() => {
          const p = panMap.get(uid);
          if (!p) return null;
          return {
            panNumber: p.panNumber,
            nameOnPan: p.nameProvided,
            panType: p.pan,
            referenceId: p.panRefId,
          };
        })(),
        gstDetails: (() => {
          const g = gstMap.get(uid);
          if (!g) return null;
          return {
            gstNumber: g.gstin,
            companyAddress: g.address,
            pincode: g.pincode,
            state: g.state,
            city: g.city,
          };
        })(),
      };
    });

    // ✅ Same response format as before
    return res.status(200).json({
      success: true,
      userIds: userDetails.map((u) => u.userId),
      userDetails,
      verifiedKycCount,
      pendingKycCount,
      currentPage: Number(page),
      totalPages,
      totalCount,
    });
  } catch (error) {
    console.error("Error in getAllUsers:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching users",
      error: error.message,
    });
  }
};

const getUserById = async (req, res) => {
  try {
    const id = req.query.id || req.user._id;

    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "User ID is required" });
    }

    const user = await User.findById(id)
      .populate("Wallet", "balance holdAmount creditLimit")
      // .select("userId fullname email phoneNumber company kycDone creditLimit createdAt")
      .lean();
    // console.log("user", user);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    const kamDetails = await KamDetails.findOne({ userId: user._id }).lean();

    const [plan, b2bPlan, codPlan, account, aadhar, pan, gst, billingAddress] =
      await Promise.all([
        Plan.findOne({ userId: user._id }).lean(),
        B2BPlan.findOne({ userId: user._id }).lean(),
        CodPlans.findOne({ user: user._id }).lean(),
        Account.findOne({ user: user._id }).lean(),
        Aadhar.findOne({ user: user._id }).lean(),
        Pan.findOne({ user: user._id }).lean(),
        Gst.findOne({ user: user._id }).lean(),
        BillingAddress.findOne({ user: user._id }).lean(),
      ]);

    const walletBalance = user.Wallet?.balance || 0;
    const holdAmount = user.Wallet?.holdAmount;

    const userDetails = {
      id: user._id,
      userId: user.userId,
      fullname: user.fullname,
      email: user.email,
      phoneNumber: user.phoneNumber,
      company: user.company,
      kycStatus: user.kycDone,
      walletAmount: walletBalance,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      holdAmount: holdAmount,
      creditLimit: user.Wallet?.creditLimit || 0,
      rateCard: plan?.planName || "N/A",
      b2bRateCard: b2bPlan?.planName || "N/A",
      codPlan: codPlan?.planName || "N/A",
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      isBlocked: user.isBlocked,
      adminApiAccess: user.adminApiAccess,
      apiAccess: user.apiAccess,
      logo: user.profileImage || "",
      referralCode: user.referralCode || "",
      lastLogin: user.lastLogin,
      referralCommissionPercentage: user.referralCommissionPercentage || 0,
      kamDetails: kamDetails
        ? {
            kamName: kamDetails.kamName,
            kamEmail: kamDetails.kamEmail,
            kamPhone: kamDetails.kamPhone,
          }
        : {
            kamName: "",
            kamEmail: "",
            kamPhone: "",
          },
      accountDetails: account
        ? {
            beneficiaryName: account.nameAtBank,
            accountNumber: account.accountNumber,
            ifscCode: account.ifsc,
            bankName: account.bank,
            branchName: account.branch,
          }
        : null,
      aadharDetails: aadhar
        ? {
            aadharNumber: aadhar.aadhaarNumber,
            nameOnAadhar: aadhar.name,
            state: aadhar.state,
            address: aadhar.address,
          }
        : null,
      panDetails: pan
        ? {
            panNumber: pan.pan,
            nameOnPan: pan.nameProvided,
            panType: pan.pan,
            referenceId: pan.panRefId,
          }
        : null,
      gstDetails: gst
        ? {
            gstNumber: gst.gstin,
            companyAddress: gst.address,
            pincode: gst.pincode,
            state: gst.state,
            city: gst.city,
          }
        : null,
      billingAddress: billingAddress,
    };
    // console.log(userDetails);

    return res.status(200).json({
      success: true,
      userDetails,
    });
  } catch (error) {
    console.error("Error in getUserById:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching user by ID",
      error: error.message,
    });
  }
};

const updateBlockStatus = async (req, res) => {
  try {
    const { userId, isBlocked } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update block status
    user.isBlocked = isBlocked;
    await user.save();

    res.status(200).json({
      success: true,
      message: `User has been ${
        isBlocked ? "blocked" : "unblocked"
      } successfully.`,
      user,
    });
  } catch (error) {
    console.error("Error updating user block status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating user block status.",
      error: error.message,
    });
  }
};

async function generateWalletReport() {
  try {
    // 1️⃣ Fetch Users and Wallet IDs they reference
    const users = await User.find({}, { Wallet: 1 });
    const usedWalletIds = users
      .filter((u) => u.Wallet)
      .map((u) => u.Wallet.toString());

    // 2️⃣ Fetch all Wallets
    const allWallets = await Wallet.find({}).select("_id balance holdAmount walletHistory");
    const allWalletIds = allWallets.map((w) => w._id.toString());

    console.log("\n==================== WALLET REPORT ====================");

    console.log(`👤 Total Users: ${users.length}`);
    console.log(`👜 Total Wallets in DB: ${allWalletIds.length}`);
    console.log(`🔗 Wallets referenced by Users: ${usedWalletIds.length}`);

    // 3️⃣ Orphan wallets (not linked to user)
    const orphanWallets = allWallets.filter(
      (w) => !usedWalletIds.includes(w._id.toString())
    );

    console.log(`❗ Orphan Wallets (no user linked): ${orphanWallets.length}`);

    // 4️⃣ Duplicate wallet references
    const walletCountMap = {};
    users.forEach((u) => {
      if (u.Wallet) {
        const wid = u.Wallet.toString();
        walletCountMap[wid] = (walletCountMap[wid] || 0) + 1;
      }
    });

    const duplicateWallets = Object.entries(walletCountMap)
      .filter(([wid, count]) => count > 1)
      .map(([wid, count]) => ({ walletId: wid, userCount: count }));

    console.log(
      `⚠ Duplicate Wallet IDs (shared by multiple users): ${duplicateWallets.length}`
    );

    // 5️⃣ Users missing wallet assignment
    const usersWithoutWallet = users.filter((u) => !u.Wallet);

    console.log(
      `🚫 Users without wallet assigned: ${usersWithoutWallet.length}`
    );

    // 6️⃣ Filter SAFE orphan wallets that CAN be deleted
    const safeToDeleteOrphans = orphanWallets.filter((w) => {
      return (
        (w.balance || 0) === 0 &&
        (w.holdAmount || 0) === 0 &&
        (!w.walletHistory || w.walletHistory.length === 0)
      );
    });

    console.log(
      `\n🟢 Safe orphan wallets to delete (zero amount + no history): ${safeToDeleteOrphans.length}`
    );

    console.log(
      "Wallet IDs to be deleted:",
      safeToDeleteOrphans.map((w) => w._id.toString())
    );

    // 7️⃣ DELETE ONLY safe orphan wallets
    const deleteResult = await Wallet.deleteMany({
      _id: { $in: safeToDeleteOrphans.map((w) => w._id) },
    });

    console.log(
      `\n🗑 Deleted Wallet Count: ${deleteResult.deletedCount} (only safe orphans)`
    );

    console.log("\n==================== END REPORT ====================\n");
  } catch (err) {
    console.error("❌ Error generating report:", err);
  }
}

// Run the function
// generateWalletReport();

const updateApiAccess = async (req, res) => {
  try {
    const { userId: bodyUserId, apiAccess, adminApiAccess } = req.body;

    // If userId is provided in body → update apiAccess
    // If userId is not provided → use req.user._id and update adminApiAccess
    const targetUserId = bodyUserId || req.user?._id;

    if (!targetUserId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Fetch user
    const user = await User.findById(targetUserId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Condition 1: userId comes from req.body → update apiAccess
    if (bodyUserId) {
      user.adminApiAccess = adminApiAccess;
    }

    // Condition 2: userId comes from req.user → update adminApiAccess
    if (!bodyUserId && req.user) {
      user.apiAccess = apiAccess;
    }

    await user.save();

    return res.status(200).json({
      success: true,
      message: bodyUserId
        ? `API Access has been ${
            apiAccess ? "enabled" : "disabled"
          } successfully.`
        : `Admin API Access has been ${
            adminApiAccess ? "enabled" : "disabled"
          } successfully.`,
      user,
    });
  } catch (error) {
    console.error("Error updating API access:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error while updating API access.",
      error: error.message,
    });
  }
};

const getUserDetails = async (req, res) => {
  try {
    const userId = req.user._id;

    // Populate only necessary fields (faster)
    const existingUser = await User.findById(userId)
      // .populate("wareHouse", "name address")
      .populate("Wallet", "balance holdAmount");
    // .populate("plan", "name expiryDate rateCard");

    if (!existingUser)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    let balance = existingUser?.Wallet?.balance || 0;
    let holdAmount = existingUser?.Wallet?.holdAmount || 0;

    // If admin with adminTab, compute using aggregation
    if (existingUser?.isAdmin && existingUser?.adminTab) {
      const totals = await User.aggregate([
        {
          $lookup: {
            from: "wallets", // collection name must match your Wallet model
            localField: "Wallet",
            foreignField: "_id",
            as: "wallet",
          },
        },
        { $unwind: "$wallet" },
        {
          $group: {
            _id: null,
            totalBalance: { $sum: "$wallet.balance" },
            totalHoldAmount: { $sum: "$wallet.holdAmount" },
          },
        },
      ]);

      if (totals.length > 0) {
        balance = totals[0].totalBalance;
        holdAmount = totals[0].totalHoldAmount;
      }

      // Inject totals into user response
      if (existingUser.Wallet) {
        existingUser.Wallet.balance = balance;
        existingUser.Wallet.holdAmount = holdAmount;
      }
    }

    return res.status(200).json({
      success: true,
      user: existingUser,
    });
  } catch (error) {
    console.error("Error in getUserDetails:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

const changeUser = async (req, res) => {
  try {
    // console.log("hi");
    const userId = req.user
      ? req.user.id
      : req.employee
      ? req.employee.id
      : null;
    if (!userId) {
      return res
        .status(401)
        .json({ message: "Unauthorized: user not found in token" });
    }
    const { adminTab } = req.body;
    // console.log("ad", adminTab);

    if (typeof adminTab !== "boolean") {
      return res.status(400).json({ message: "Invalid adminTab value" });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { adminTab },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      message: "User tab view updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("Error updating user adminTab:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const getAllPlans = async (req, res) => {
  try {
    const allPlans = await Plan.find({});
    res.status(201).json({
      success: true,
      data: allPlans,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch plans",
      error: error.message,
    });
  }
};

const assignPlan = async (req, res) => {
  try {
    const {
      userId,
      userName,
      planName,
      rateCards = [],
    } = req.body;

    if (!planName) {
      return res.status(400).json({
        error: "Plan name is required",
      });
    }

    if (rateCards.length === 0) {
      return res.status(400).json({
        error: "At least one rate card (B2C) is required",
      });
    }

    // ✅ Disable DTDC by default for all users
    const processedRateCards = rateCards.map(rc => {
      if (rc.courierProviderName?.toLowerCase().includes("dtdc")) {
        return { ...rc, status: "Inactive" };
      }
      return rc;
    });

    // Check if there is an existing plan for the user
    let existingPlan = await Plan.findOne({ userId });

    if (existingPlan) {
      existingPlan.planName = planName;
      existingPlan.rateCard = processedRateCards;
      existingPlan.assignedAt = new Date();

      await existingPlan.save();
      
      // Log the action
      const performerId = req.user?._id || req.employee?._id;
      if (performerId) {
        await ActivityLog.create({
          performedBy: performerId,
          action: "EDIT",
          module: "RATE_CARD",
          planName: planName,
          details: {
            targetUserId: userId,
            targetUserName: userName,
            type: "B2C_ASSIGN"
          }
        });
      }

      return res.status(200).json({
        message: "Plan updated successfully",
        plan: existingPlan,
      });
    }

    const newPlan = new Plan({
      userId,
      userName,
      planName,
      rateCard: processedRateCards,
      assignedAt: new Date(),
    });

    await newPlan.save();

    // Log the action
    const performerId = req.user?._id || req.employee?._id;
    if (performerId) {
      await ActivityLog.create({
        performedBy: performerId,
        action: "ADD",
        module: "RATE_CARD",
        planName: planName,
        details: {
          targetUserId: userId,
          targetUserName: userName,
          type: "B2C_ASSIGN"
        }
      });
    }

    return res.status(201).json({
      message: "Plan assigned successfully",
      plan: newPlan,
    });
  } catch (err) {
    console.error("Assign Plan Error:", err);
    return res.status(500).json({
      error: "Failed to assign plan",
    });
  }
};



const B2BassignPlan = async (req, res) => {
  try {
    const {
      userId,
      userName,
      planName,
      B2BRateCard = [],
    } = req.body;

    if (!planName) {
      return res.status(400).json({
        error: "Plan name is required",
      });
    }

    if (B2BRateCard.length === 0) {
      return res.status(400).json({
        error: "At least one rate card (B2B) is required",
      });
    }

    // ✅ Disable DTDC by default for all users
    const processedB2BRateCards = B2BRateCard.map(rc => {
      if (rc.courierProviderName?.toLowerCase().includes("dtdc")) {
        return { ...rc, status: "Inactive" };
      }
      return rc;
    });

    // Check if there is an existing plan for the user
    let existingPlan = await B2BPlan.findOne({ userId });

    if (existingPlan) {
      existingPlan.planName = planName;
      existingPlan.B2BRateCard = processedB2BRateCards;
      existingPlan.assignedAt = new Date();

      await existingPlan.save();

      return res.status(200).json({
        message: "Plan updated successfully",
        plan: existingPlan,
      });
    }

    const newPlan = new B2BPlan({
      userId,
      userName,
      planName,
      B2BRateCard: processedB2BRateCards,
      assignedAt: new Date(),
    });

    await newPlan.save();

    return res.status(201).json({
      message: "Plan assigned successfully",
      plan: newPlan,
    });
  } catch (err) {
    console.error("Assign Plan Error:", err);
    return res.status(500).json({
      error: "Failed to assign plan",
    });
  }
};


const makeAdmin = async () => {
  try {
    const userId = 17333;

    const updatedUser = await User.findOneAndUpdate(
      { userId: userId },
      { isAdmin: true },
      { new: true }
    );

    if (!updatedUser) {
      console.log("❌ User not found");
    } else {
      console.log("✅ User updated to admin:", updatedUser);
    }
  } catch (error) {
    console.error("❌ Error making user admin:", error.message);
  }
};

// makeAdmin();

const getRatecards = async (req, res) => {
  try {
    const { plan: currentPlan } = req.body;

    // Validate input
    if (!currentPlan) {
      return res.status(400).json({
        success: false,
        message: "Plan is required.",
      });
    }

    const rateCard = await RateCard.find({ type: currentPlan });

    if (!rateCard || rateCard.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No rate cards found for the specified plan.",
      });
    }
    res.status(201).json({
      success: true,
      message: "Rate cards retrieved successfully.",
      data: rateCard,
    });
  } catch (error) {
    console.error("Error fetching rate cards:", error);
    res.status(500).json({
      success: false,
      message:
        "An error occurred while fetching rate cards. Please try again later.",
      error: error.message,
    });
  }
};

// Update profile controller
const updateProfile = async (req, res) => {
  try {
    const userId = req.user._id; // Assuming authentication middleware sets this
    const { brandName, website } = req.body;

    let updateData = {
      brandName,
      website,
    };

    // If image uploaded, add profileImage S3 URL
    if (req.file && req.file.location) {
      updateData.profileImage = req.file.location;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
    });

    res.status(200).json({
      message: "Profile updated successfully",
      user: updatedUser,
    });
  } catch (err) {
    console.error("Error updating profile:", err);
    res.status(500).json({ error: "Server error" });
  }
};

const updateReferralCommission = async (req, res) => {
  try {
    const { userId, referralCommissionPercentage } = req.body;
    await User.findByIdAndUpdate(userId, { referralCommissionPercentage });
    res.json({
      success: true,
      message: "Referral commission updated successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to update referral commission",
    });
  }
};

const updateCreditLimit = async (req, res) => {
  try {
    const { userId, creditLimit } = req.body;

    if (!userId || creditLimit === undefined) {
      return res.status(400).json({
        success: false,
        message: "userId and creditLimit are required",
      });
    }

    // ---- Fetch User ----
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (!user.Wallet) {
      return res.status(400).json({
        success: false,
        message: "Wallet not linked to this user",
      });
    }

    // ---- Fetch Wallet ----
    const wallet = await Wallet.findById(user.Wallet).select("creditLimit");
    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found",
      });
    }

    // ---- Update Credit Limit ----
    wallet.creditLimit = creditLimit;
    await wallet.save();

    return res.status(200).json({
      success: true,
      message: "Credit limit updated successfully",
      creditLimit: wallet.creditLimit,
    });
  } catch (error) {
    console.error("Update Credit Limit Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

const getKamDetails = async (req, res) => {
  try {
    const { id } = req.params; // userId

    const kam = await KamDetails.findOne({ userId: id });

    if (!kam) {
      return res.json({
        kamName: "",
        kamEmail: "",
        kamPhone: "",
        userId: id,
      });
    }

    return res.json(kam);
  } catch (error) {
    console.error("Error fetching KAM details:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

const updateKamDetails = async (req, res) => {
  try {
    const { id } = req.params; // userId
    const { kamName, kamEmail, kamPhone } = req.body;

    const updated = await KamDetails.findOneAndUpdate(
      { userId: id },
      {
        userId: id,
        kamName,
        kamEmail,
        kamPhone,
      },
      { new: true, upsert: true }
    );

    return res.json(updated);
  } catch (error) {
    console.error("Error updating KAM details:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

const getUserServices = async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ message: "User ID is required" });

    const plan = await Plan.findOne({ userId });
    res.status(200).json({
      success: true,
      services: plan ? plan.rateCard : []
    });
  } catch (error) {
    console.error("Error fetching user services:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const toggleProviderStatus = async (req, res) => {
  try {
    const { userId, provider, status } = req.body;
    const plan = await Plan.findOne({ userId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    plan.rateCard = plan.rateCard.map(rc => {
      if (rc.courierProviderName === provider) {
        return { ...rc, status: status ? "Active" : "Inactive" };
      }
      return rc;
    });

    await Plan.updateOne({ userId }, { $set: { rateCard: plan.rateCard } });

    // Log the action
    const performerId = req.user?._id || req.employee?._id;
    if (performerId) {
      await ActivityLog.create({
        performedBy: performerId,
        action: "EDIT",
        module: "RATE_CARD",
        planName: plan.planName,
        details: {
          targetUserId: userId,
          provider: provider,
          newStatus: status ? "Active" : "Inactive",
          type: "PROVIDER_TOGGLE"
        }
      });
    }

    res.status(200).json({ success: true, message: `${provider} services ${status ? "enabled" : "disabled"} successfully` });
  } catch (error) {
    console.error("Error toggling provider status:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const toggleServiceStatus = async (req, res) => {
  try {
    const { userId, courierServiceName, status } = req.body;
    const plan = await Plan.findOne({ userId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    plan.rateCard = plan.rateCard.map(rc => {
      if (rc.courierServiceName === courierServiceName) {
        return { ...rc, status: status ? "Active" : "Inactive" };
      }
      return rc;
    });

    await Plan.updateOne({ userId }, { $set: { rateCard: plan.rateCard } });
    
    // Log the action
    const performerId = req.user?._id || req.employee?._id;
    if (performerId) {
      await ActivityLog.create({
        performedBy: performerId,
        action: "EDIT",
        module: "RATE_CARD",
        planName: plan.planName,
        details: {
          targetUserId: userId,
          courierServiceName: courierServiceName,
          newStatus: status ? "Active" : "Inactive",
          type: "SERVICE_TOGGLE"
        }
      });
    }

    res.status(200).json({ success: true, message: `Service ${status ? "enabled" : "disabled"} successfully` });
  } catch (error) {
    console.error("Error toggling service status:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const updateServiceRate = async (req, res) => {
  try {
    const { userId, courierServiceName, weightPriceBasic, weightPriceAdditional, codCharge, codPercent } = req.body;
    const plan = await Plan.findOne({ userId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    plan.rateCard = plan.rateCard.map(rc => {
      if (rc.courierServiceName === courierServiceName) {
        return {
          ...rc,
          weightPriceBasic,
          weightPriceAdditional,
          codCharge,
          codPercent,
          isCustomRate: true
        };
      }
      return rc;
    });

    await Plan.updateOne({ userId }, { $set: { rateCard: plan.rateCard } });

    // Log the action
    const performerId = req.user?._id || req.employee?._id;
    if (performerId) {
      await ActivityLog.create({
        performedBy: performerId,
        action: "EDIT",
        module: "RATE_CARD",
        planName: plan.planName,
        details: {
          targetUserId: userId,
          courierServiceName: courierServiceName,
          type: "RATE_OVERRIDE"
        }
      });
    }

    res.status(200).json({ success: true, message: "Rate updated successfully" });
  } catch (error) {
    console.error("Error updating service rate:", error);
    res.status(500).json({ message: "Server error" });
  }
};


// ─── Admin: search users by name/email/phone for suggestions ───────────────
const searchUsers = async (req, res) => {
  try {
    // Only allow admins (User or Staff/Employee)
    const isAdmin = req.user?.isAdmin || req.employee?.isAdmin;

    if (!isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const { q = "" } = req.query;
    if (!q.trim()) {
      return res.status(200).json({ success: true, users: [] });
    }

    const trimmed = q.trim();
    const users = await User.find(
      {
        $or: [
          { fullname: { $regex: trimmed, $options: "i" } },
          { email: { $regex: trimmed, $options: "i" } },
          { phoneNumber: { $regex: trimmed, $options: "i" } },
          { company: { $regex: trimmed, $options: "i" } },
        ],
      },
      { _id: 1, fullname: 1, email: 1, company: 1, userId: 1 }
    )
      .limit(10)
      .lean();

    return res.status(200).json({
      success: true,
      users: users.map((u) => ({
        id: u._id,
        userId: u.userId,
        fullname: u.fullname,
        email: u.email,
        company: u.company,
      })),
    });
  } catch (error) {
    console.error("searchUsers error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ─── Admin: generate a login token for any user (no password required) ───────
const adminLoginAsUser = async (req, res) => {
  try {
    // Only allow admins (User or Staff/Employee)
    const isAdmin = req.user?.isAdmin || req.employee?.isAdmin;

    if (!isAdmin) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const { userId } = req.body; // mongo _id of the target user
    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (targetUser.isBlocked) {
      return res.status(400).json({ success: false, message: "User is blocked" });
    }

    const payload = {
      user: {
        id: targetUser._id,
        email: targetUser.email,
        fullname: targetUser.fullname,
        kyc: targetUser.kycDone,
        isAdmin: targetUser.isAdmin,
        isEmployee: false,
      },
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" });

    return res.status(200).json({
      success: true,
      message: `Logged in as ${targetUser.fullname}`,
      token,
    });
  } catch (error) {
    console.error("adminLoginAsUser error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateKycStatus = async (req, res) => {
  try {
    const { userId, kycStatus } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update KYC status
    user.kycDone = kycStatus;
    await user.save();

    res.status(200).json({
      success: true,
      message: `KYC status has been ${
        kycStatus ? "verified" : "unverified"
      } successfully.`,
      user,
    });
  } catch (error) {
    console.error("Error updating user KYC status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating user KYC status.",
      error: error.message,
    });
  }
};

module.exports = {
  getUsers,
  getUserDetails,
  getAllPlans,
  assignPlan,
  B2BassignPlan,
  getRatecards,
  getAllUsers,
  changeUser,
  getUserById,
  updateBlockStatus,
  updateKycStatus,
  updateApiAccess,
  updateProfile,
  updateReferralCommission,
  updateCreditLimit,
  getKamDetails,
  updateKamDetails,
  getUserServices,
  toggleProviderStatus,
  toggleServiceStatus,
  updateServiceRate,
  searchUsers,
  adminLoginAsUser,
  checkGstForUser,
};

