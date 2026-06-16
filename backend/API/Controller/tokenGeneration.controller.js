const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../../models/User.model"); // adjust the path as needed
const { validateEmail } = require("../../utils/afv"); // adjust path if needed

const generateToken = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Check for empty fields
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // 2. Validate email format
    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    // 3. Check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // 🔍 3.1 Check API access
    if (user.adminApiAccess === false) {
      return res.status(403).json({
        success: false,
        message:
          "Please contact your Sales Manager or support at tech@shiproxx.com",
      });
    }

    if (user.apiAccess === false) {
      return res.status(403).json({
        success: false,
        message:
          "API access is disabled for your account. Please enable it from your settings -> company profile -> API Details",
      });
    }

    // 4. Compare password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Incorrect password",
      });
    }

    // 5. Create JWT payload
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

    // 6. Sign JWT token
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    // 7. Respond with token
    return res.status(200).json({
      success: true,
      message: "Token generated successfully",
      data: {
        token,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const generateTokenWithoutPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

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

    return res.status(200).json({
      success: true,
      message: "Token generated successfully without password",
      data: {
        token,
      },
    });
  } catch (error) {
    console.error("Token generation error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = { generateToken, generateTokenWithoutPassword };
