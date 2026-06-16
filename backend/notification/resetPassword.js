const express = require("express");
const crypto = require("crypto");
const transporter = require("./configEmailpass");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User.model");

const resetPassword = express.Router();

// MongoDB Schema and model for password reset tokens
const PasswordResetSchema = new mongoose.Schema({
  email: { type: String, required: true },
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});

const PasswordResetModel = mongoose.model("PasswordReset", PasswordResetSchema);

// Endpoint to request password reset, send email with valid link for 60 minutes
resetPassword.post("/resetPassword", async (req, res) => {
  const { email } = req.body;
// console.log("Using Email Key:", process.env.NOTIFICATION_PASS ? "Key Loaded" : "Key MISSING");
  if (!email) {
    return res
      .status(400)
      .json({ success: false, message: "Email is required" });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res
      .status(404)
      .json({ success: false, message: "User with this email does not exist" });
  }

  if (user.isBlocked) {
    return res
      .status(400)
      .json({
        success: false,
        message: "Your account has been temporarily blocked. Please contact support.",
      });
  }

  try {
    // Generate a cryptographically strong random token
    const token = crypto.randomBytes(32).toString("hex");

    // Set expiry time 60 minutes from now
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Save token for this email in DB (upsert)
    await PasswordResetModel.findOneAndUpdate(
      { email },
      { token, expiresAt },
      { upsert: true, new: true }
    );

    // Prepare email content
    const logoUrl =
      "https://shiproxx-india.s3.ap-south-1.amazonaws.com/uploads/1758806046534_shiproxxNoBG.png";
    const productName = "Shiproxx";
    const resetUrl = `https://app.shiproxx.com/reset-password?token=${token}`;
    const supportEmail = "info@shiproxx.com";
    const brandName = "Shiproxx";

    // Format expiry for email in readable string with timezone
    const expiryText = expiresAt.toLocaleString("en-IN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: true,
      timeZoneName: "short",
    });

    const mailOptions = {
      from: '"Shiproxx Team" <info@shiproxx.com>',
      to: email,
      subject: `Reset Your ${productName} Password`,
      html: `
        <table cellspacing="0" cellpadding="0" style="margin:0 auto;width:100%;background-color:#f9f9f9;">
          <tr>
            <td>
              <div style="background:#fff;border:1px solid #eee;font-family:Lato,Helvetica,Arial,sans-serif;margin:32px auto;max-width:540px;border-radius:16px;overflow:hidden;box-sizing:border-box;">
                <div style="text-align:center;background:#eee;padding:25px 0 25px 25px;">
                  <img src="${logoUrl}" alt="${productName} Logo" style="max-height:60px;width:auto;">
                </div>
                <div style="padding:20px 30px 34px 30px;text-align:center">
                  <h2 style="font-size:23px;font-weight:700;color:#232323;margin:0 0 24px;">Reset Password</h2>
                  <p style="font-size:16px;color:#222;margin-bottom:22px;">
                    You have requested a password reset for your <b>${productName}</b> account with the email <b>${email}</b>.<br><br>
                    Click on the below link to reset your password securely
                  </p>
                  <a href="${resetUrl}" target="_blank"
                    style="display:inline-block; background-color:#10BE3B; color:#fff; font-size:16px; font-weight:500; border-radius:6px; padding:13px 38px; margin:18px 0 25px 0; text-decoration:none;line-height:19px;">
                    Reset password
                  </a>
                  <div style="background:#f4f4f4; color:#222; font-size:15px; border-radius:10px; padding:18px 5px 12px 5px; margin:25px 0 24px 0;">
                    The provided link will <span style="color:#b60000;">expire on ${expiryText}</span>.
                  </div>
                  <p style="font-size:15px;color:#222;line-height:21px;margin-bottom:12px;">
                    If you have further questions, write to us at
                    <a href="mailto:${supportEmail}" style="color:#10BE3B;">${supportEmail}</a> and our team will get back to you.
                  </p>
                  <div style="margin-top:20px;font-size:14px;color:#444;">
                    Have a great day!<br>
                    <span style="font-weight:700;">Team ${brandName}</span>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </table>
      `,
    };

    // Send the reset email
    const mailSent = await transporter.sendMail(mailOptions);
    console.log("Password reset mail sent:", mailSent);

    return res.json({
      success: true,
      message: "Password reset email sent successfully",
    });
  } catch (err) {
    console.error(
      "Error generating password reset token or sending email",
      err
    );
    return res
      .status(500)
      .json({ success: false, message: "Failed to send password reset email" });
  }
});

// Endpoint to verify token and reset password

resetPassword.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res
      .status(400)
      .json({ success: false, message: "Token and new password are required" });
  }

  try {
    // Lookup token in DB
    const resetRecord = await PasswordResetModel.findOne({ token });
    if (!resetRecord) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid or expired token" });
    }

    // Validate expiry
    if (resetRecord.expiresAt < new Date()) {
      await PasswordResetModel.deleteOne({ token });
      return res
        .status(400)
        .json({ success: false, message: "Reset token has expired" });
    }

    // 🔑 Find the user by email from token record
    const user = await User.findOne({ email: resetRecord.email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // 🔑 Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // 🔑 Update password
    user.password = hashedPassword;
    await user.save();

    // Delete token after successful reset
    await PasswordResetModel.deleteOne({ token });

    return res.json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    console.error("Error resetting password", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = { resetPassword };
