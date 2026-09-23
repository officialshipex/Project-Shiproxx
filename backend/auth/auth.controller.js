if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const { validateForm, validateEmail } = require("../utils/afv");
const User = require("../models/User.model");
const Role = require("../models/roles.modal");
const RateCard = require("../models/rateCards");
const B2BRateCard = require("../B2B/models/ratecard.model");
const Plan = require("../models/Plan.model");
const B2BPlan = require("../B2B/models/plan.model");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { sendWelcomeEmail } = require("../notification/welcomeNotification");
const FRONTEND_URL =
  process.env.NODE_ENV != "production"
    ? "http://localhost:5173"
    : process.env.FRONTEND_URL;
//for User Registration

const register = async (req, res) => {
  try {
    const {
      fullname,
      email,
      phoneNumber,
      company,
      monthlyOrders,
      password,
      confirmedPassword,
      checked,
      referralCode: referralCodeFromUrl,
    } = req.body;

    if (
      !fullname ||
      !email ||
      !phoneNumber ||
      !company ||
      !monthlyOrders ||
      !password ||
      !confirmedPassword
    ) {
      return res.status(400).json({
        success: false,
        message: "Please fill all the fields",
      });
    }

    const userData = {
      fullname,
      email,
      phoneNumber,
      company,
      monthlyOrders,
      password,
      confirmedPassword,
      checked,
    };

    const validateFields = validateForm(userData);
    if (Object.keys(validateFields).length) {
      return res.status(400).json({
        success: false,
        message: validateFields,
      });
    }

    // ✅ Generate unique 5-digit userId
    let userId;
    let isUnique = false;

    while (!isUnique) {
      userId = Math.floor(10000 + Math.random() * 90000);
      const existingUser = await User.findOne({ userId });
      if (!existingUser) isUnique = true;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Generate unique 7-digit referral code for the new user
    let uniqueReferralCode;
    let isCodeUnique = false;

    while (!isCodeUnique) {
      uniqueReferralCode = Math.floor(
        1000000 + Math.random() * 9000000,
      ).toString();
      const codeExists = await User.findOne({
        referralCode: uniqueReferralCode,
      });
      if (!codeExists) isCodeUnique = true;
    }

    // ✅ Create new user
    const newUser = new User({
      fullname,
      email,
      phoneNumber,
      company,
      monthlyOrders,
      password: hashedPassword,
      userId,
      referralCode: uniqueReferralCode, // new field
      // Email OTP verification is currently unusable (no Zepto email sending
      // configured) — mark verified at signup rather than leave the user
      // permanently stuck unverified with no way to receive the OTP.
      isEmailVerified: true,
    });

    // ✅ Referral Handling
    if (referralCodeFromUrl) {
      const referrer = await User.findOne({
        referralCode: referralCodeFromUrl,
      });
      if (referrer) {
        newUser.referredBy = referrer._id;

        // Add this new userId to referrer's subUserId array
        if (!Array.isArray(referrer.subUserId)) {
          referrer.subUserId = [];
        }
        referrer.subUserId.push(newUser._id);
        await referrer.save();
      }
    }

    await newUser.save();
    await sendWelcomeEmail(email, fullname, password);

    // Assign "Bronze" rate card
    const bronzeRateCard = await RateCard.find({ plan: "Bronze" });
    if (!bronzeRateCard) {
      return res.status(500).json({
        success: false,
        message: "Bronze rate card not found",
      });
    }
    const newPlan = new Plan({
      userId: newUser._id,
      userName: fullname,
      planName: "Bronze",
      rateCard: bronzeRateCard,
    });
    await newPlan.save();

    //Assign "LITE" B2B rate card
    const liteRateCard = await B2BRateCard.find({ planName: "LITE" });
    if (!liteRateCard) {
      return res.status(500).json({
        success: false,
        message: "LITE rate card not found",
      });
    }
    const b2bPlan = new B2BPlan({
      userId: newUser._id,
      userName: fullname,
      planName: "LITE",
      b2bRateCard: liteRateCard,
    });
    await b2bPlan.save();

    const payload = {
      user: {
        id: newUser._id,
        email: newUser.email,
        fullname: newUser.fullname,
      },
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    return res.status(200).json({
      success: true,
      message: "User registered successfully",
      data: token,
    });
  } catch (error) {
    // ✅ Duplicate key error (email / phoneNumber / company)
    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyValue)[0];

      return res.status(409).json({
        success: false,
        message: `${duplicateField} already exists`,
        field: duplicateField,
      });
    }

    console.error("Registration error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

//For User Login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Please fill all the fields",
      });
    }

    const validateFields = validateEmail(email);

    if (!validateFields) {
      return res.status(400).json({
        success: false,
        message: "Invalid email ",
      });
    }

    const user = await User.findOne({ email });
    // console.log("user", user);
    if (!user) {
      return res.status(400).json({
        success: false,
        message: "User does not exist",
      });
    }

    const checkPassword = await bcrypt.compare(password, user.password);

    if (!checkPassword) {
      return res.status(400).json({
        success: false,
        message: "Password is incorrect",
      });
    }
    if (user.isBlocked) {
      return res.status(400).json({
        success: false,
        message:
          "Your account has been temporarily blocked. Please contact support.",
      });
    }
    // 🔹 Save last login date & time
    user.lastLogin = new Date();
    await user.save();

    const payload = {
      user: {
        id: user._id,
        email: user.email,
        fullname: user.fullname,
        kyc: user.kycDone,
        isAdmin: user.isAdmin,
        isEmployee: false,
      },
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });
    // console.log("token",token)

    return res.status(200).json({
      success: true,
      message: "User logged in successfully",
      kyc: user.kycDone,
      data: token,
    });
  } catch (error) {
    console.log("error", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

//For successfull Google login
const googleLogin = async (req, res) => {
  try {
    const profile = req.user;
    // console.log("profile", profile);
    const userExist = await User.findOne({ email: profile.email });
    if (!userExist) {
      const newUser = new User({
        fullname: profile.name.givenName,
        email: profile.email,
        monthlyOrders: profile.monthlyOrders || 0,
        googleOAuthID: profile.id,
        isVerified: profile.email_verified,
        // Same reasoning as the password-signup path in register() above —
        // email OTP verification is currently unusable, so mark verified at
        // signup. (Separate from `isVerified` above, which is KYC status.)
        isEmailVerified: true,
        provider: "Google",
      });

      await newUser.save();
    }

    const user = await User.findOne({ email: profile.email });
    const payload = {
      user: {
        id: user._id,
        email: user.email,
        fullname: user.fullname,
      },
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    return res.redirect(`${FRONTEND_URL}/login?token=${token}`);

    // return res.status(200).json({
    //   success: true,
    //   message: "User logged in successfully",
    //   data: token,
    // })
  } catch (error) {
    console.log("error", error);
    return res.redirect(`${FRONTEND_URL}`);
    // return res.status(500).json({
    //   success: false,
    //   message: "Internal server error",
    // });
  }
};

//for failure google login
const googleLoginFail = (req, res) => {
  try {
    return res.status(400).json({
      success: false,
      message: "Google login failed",
    });
  } catch (error) {
    console.log("error", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const verifySession = async (req, res) => {
  try {
    const session = req.headers.authorization;

    if (!session) {
      return res.status(400).json({
        success: false,
        message: "Session not found",
      });
    }

    const token = session.split(" ")[1];

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Token not found",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded) {
      return res.status(400).json({
        success: false,
        message: "Invalid token",
      });
    }

    // User session
    if (decoded.user && decoded.user.isEmployee === false) {
      const user = await User.findById(decoded.user.id);
      if (!user) {
        return res.status(400).json({
          success: false,
          message: "User not found",
        });
      }
      return res.status(200).json({
        success: true,
        kyc: user.kycDone,
        message: "Token verified",
        type: "user",
      });
    }
    // Employee session
    else if (decoded.employee && decoded.employee.isEmployee === true) {
      const employee = await Role.findById(decoded.employee.id);
      if (!employee) {
        return res.status(400).json({
          success: false,
          message: "Employee not found",
        });
      }
      return res.status(200).json({
        success: true,
        message: "Token verified",
        type: "employee",
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid token payload",
      });
    }
  } catch (error) {
    console.log("error", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const forgetPassword = async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Hash the new password before saving
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    res.json({ message: "Password Reset successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error updating password", error });
  }
};

const changePassword = async (email, newPassword) => {
  try {
    if (!email || !newPassword) {
      console.error("Email and new password are required");
      return false;
    }

    const user = await User.findOne({ email });
    if (!user) {
      console.error("User not found");
      return false;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    console.log("Password changed successfully for:", email);
    return true;
  } catch (error) {
    console.error("Change password error:", error);
    return false;
  }
};

const changePasswordController = async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    // console.log("email",email)

    if (!email || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Email and new password are required",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long",
      });
    }

    const success = await changePassword(email, newPassword);

    if (success) {
      return res.status(200).json({
        success: true,
        message: "Password changed successfully",
      });
    } else {
      return res.status(404).json({
        success: false,
        message: "User not found or error updating password",
      });
    }
  } catch (error) {
    console.error("Change password controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
// changePassword("umax935@gmail.com","umax@935")
const generateReferralCodes = async () => {
  try {
    const users = await User.find({});
    let updatedCount = 0;

    for (const user of users) {
      if (!user.referralCode) {
        let uniqueCode;
        let exists = true;

        // Generate a unique 7-digit numeric code
        while (exists) {
          uniqueCode = Math.floor(1000000 + Math.random() * 9000000).toString();
          const check = await User.findOne({ referralCode: uniqueCode });
          if (!check) exists = false;
        }

        user.referralCode = uniqueCode;
        await user.save();
        updatedCount++;
      }
    }

    console.log(`✅ Referral code generation completed.`);
    console.log(`Total users: ${users.length}`);
    console.log(`Updated users: ${updatedCount}`);
  } catch (error) {
    console.error("❌ Error generating referral codes:", error.message);
  } finally {
    mongoose.connection.close();
  }
};

// generateReferralCodes()

module.exports = {
  register,
  login,
  googleLogin,
  googleLoginFail,
  verifySession,
  forgetPassword,
  changePassword,
  changePasswordController,
};
