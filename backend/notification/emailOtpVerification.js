const transporter = require("./configEmailpass");
const express = require("express");
const OTPs = {}; // Store OTPs temporarily
const emailOtpRouter = express.Router();
const axios = require("axios");
const User = require("../models/User.model");
const { isAuthorized } = require("../middleware/auth.middleware");
emailOtpRouter.post("/send-email-otp", async (req, res) => {
  const { email } = req.body;

  // console.log("kkkk", email);
  if (!email) {
    return res
      .status(400)
      .json({ success: false, message: "Email is required" });
  }

  // Check if email already exists and is verified
  const existingUser = await User.findOne({ email });

  if (existingUser && existingUser.isEmailVerified === true) {
    return res.status(400).json({
      success: false,
      message: "Email ID already exists",
    });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000);
  OTPs[email] = otp; // Store OTP temporarily
  // console.log("9999", otp);
  // Email Content
  const validTime = "10 minutes"; // example expiry, replace with actual expiration time

  const mailOptions = {
    from: '"Shiproxx Team" <info@shiproxx.com>',
    to: email,
    subject: "Your Verification Code",
    html: `
    <table cellspacing="0" cellpadding="0" style="margin:0 auto; width:100%; background-color:#f9f9f9;">
      <tr>
        <td>
          <div style="background:#fff; border:1px solid #eee; font-family:Lato, Helvetica, Arial, sans-serif; margin:32px auto; max-width:500px; border-radius:16px; overflow:hidden; box-sizing:border-box;">
            <!-- Header with logo -->
            <div style="padding: 25px 0 25px 0;background:#eee;text-align: center;">
              <img src="https://shiproxx-india.s3.ap-south-1.amazonaws.com/uploads/1758806046534_shiproxxNoBG.png" alt="Shiproxx Logo" style="max-height: 60px; width: auto;" />
            </div>

            <div style="padding:20px 24px; text-align:center;">
              <h1 style="color:#222; font-size:24px; font-weight:700; margin:0 0 16px;">Verification code</h1>
              <p style="font-size:15px; color:#222; margin-bottom:24px;">
                Enter the below one time password to verify your Shiproxx account:
              </p>
              <div style="font-size:28px; font-weight:600; color:#1658db; margin-bottom:8px;">
                ${otp}
              </div>
              <div style="margin-top:2px; font-size:14px; color:#b60000;">
                The verification code expires in ${validTime}
              </div>
              <hr style="border:0; border-bottom:1px solid #eee; margin:28px 0 16px;">
              <p style="font-size:15px; color:#232323; margin-bottom:8px;">
                If you have further questions, write to us at 
                <a href="mailto:info@shiproxx.com" style="color:#10BE3B;">info@shiproxx.com</a> and our team will get back to you.
              </p>
              <div style="margin-top:18px; font-size:15px; color:#444;">
                Have a great day!<br>
                <span style="font-weight:700;">Team Shiproxx</span>
              </div>
            </div>
          </div>
        </td>
      </tr>
    </table>
  `,
  };

  try {
    console.log("email", process.env.NOTIFICATION_EMAIL);
    console.log("pass", process.env.NOTIFICATION_PASS);
    const mails = await transporter.sendMail(mailOptions);
    console.log("hhhhhh", mails);
    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

emailOtpRouter.post("/verify-email-otp", isAuthorized, async (req, res) => {
  try {
    const { email, otp } = req.body;
    const id = req.user._id;

    console.log("Verifying:", email, otp, id);

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required",
      });
    }

    // Convert both to string before comparison
    if (!OTPs[email] || String(OTPs[email]) !== String(otp)) {
      console.log("Stored OTP:", OTPs[email], "Received OTP:", otp);
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Find the user
    const user = await User.findById(id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Update email and verification status
    user.email = email;
    user.isEmailVerified = true;
    await user.save();

    // Remove OTP after successful verification
    delete OTPs[email];

    res.json({ success: true, message: "Email verified successfully", user });
  } catch (error) {
    console.error("Error verifying email OTP:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const updateAllUsersVerificationStatus = async () => {
  try {
    // Update all users' verification fields
    const result = await User.updateMany(
      {},
      {
        $set: {
          isPhoneVerified: true,
          isEmailVerified: true,
        },
      }
    );

    console.log(`✅ Updated verification status for ${result.modifiedCount} users successfully.`);
  } catch (error) {
    console.error("❌ Error updating verification status:", error);
  }
};




module.exports = emailOtpRouter;
