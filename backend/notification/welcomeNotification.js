const transporter = require("./configEmailpass");

const sendWelcomeEmail = async (email, customername, password) => {
  const mailOptions = {
    from: '"Shiproxx Team" <info@shiproxx.com>',
    to: email,
    subject: "Welcome to Shiproxx – Unlock ₹5000 Cashback 🚀",
    html: `
      <table cellspacing="0" cellpadding="0" style="margin:0 auto;width:100%;background-color:#f9f9f9;">
        <tr>
          <td>
            <div style="background:#fff;border:1px solid #eee;font-family:Lato,Helvetica,Arial,sans-serif;margin:32px auto;max-width:600px;border-radius:8px;overflow:hidden;">
              <!-- Header with logo -->
              <div style="text-align:center;background:#eee;padding:30px;">
                <img src="https://shiproxx-india.s3.ap-south-1.amazonaws.com/uploads/1758806046534_shiproxxNoBG.png" alt="Shiproxx Logo" style="max-height:60px;width:auto;">
              </div>
              <div style="padding:20px 36px 24px 36px;text-align:left;color:#222;">
                <!-- Welcome -->
                <h2 style="color:#183765;font-size:22px;font-weight:700;margin:18px 0 10px;">Welcome to Shiproxx! 🎉</h2>
                <h4 style="font-size:15px;font-weight:400;margin:0 0 18px;">Dear <span style="font-weight:700;">${customername}</span>,</h4>
                <p style="font-size:15px;margin:0 0 18px;">Welcome to <span style="font-weight:700;">Shiproxx!</span> We’re thrilled to have you onboard. Start shipping with <span style="font-weight:700;">the best rates, widest serviceability, and 48hrs COD remittance.</span></p>

                <!-- Welcome Offer -->
                <h3 style="font-size:16px;font-weight:700;margin-bottom:7px;">🎁 Exclusive Welcome Offer</h3>
                <p style="font-size:15px;margin:0 0 18px;">Complete your <span style="font-weight:700;">eKYC instantly</span> and unlock cashback up to <span style="font-weight:700;">₹5000</span> in your Shiproxx wallet.</p>

                <!-- Credentials -->
                <h3 style="font-size:16px;font-weight:700;margin-bottom:7px;">🔑 Your Login Credentials</h3>
                <ul style="font-size:15px;color:#222;margin:0 0 18px;padding:0 0 0 20px;">
                  <li>Email: <span style="font-weight:700;">${email}</span></li>
                  <li>Password: <span style="font-weight:700;">${password}</span></li>
                  <li>Login URL: <a href="https://app.shiproxx.com/login" style="color:#10BE3B;text-decoration:underline;" target="_blank">Click Here to Login</a></li>
                </ul>

                

                <!-- Why Choose Shiproxx -->
                <h3 style="font-size:16px;font-weight:700;margin:28px 0 10px 0;">🚚 Why Choose Shiproxx?</h3>
                <ul style="font-size:15px;color:#222;margin:0;padding:0 0 0 20px;">
                  <li>✅ <span style="font-weight:700;">48 Hours COD Remittance</span> – Faster settlements for smooth cash flow</li>
                  <li>✅ <span style="font-weight:700;">Volumetric Weight Relaxation up to 2kg</span> – Save more on shipments</li>
                  <li>✅ <span style="font-weight:700;">Smart NDR Management</span> – Reduce returns & improve delivery rate</li>
                  <li>✅ <span style="font-weight:700;">Multiple Courier Partners</span> – One platform, all major networks</li>
                  <li>✅ <span style="font-weight:700;">Nationwide Coverage</span> – Deliver across every pin code in India</li>
                </ul>
                
                <!-- Support -->
                <div style="margin:20px 0 0;border-top:1px solid #EEE;padding-top:12px;">
                  <h4 style="font-size:15px;font-weight:700;margin-bottom:7px;">📞 We’re Here for You</h4>
                  <ul style="font-size:15px;color:#222;margin:0;padding:0 0 0 20px;">
                    <li>Email: <a href="mailto:info@shiproxx.com" style="color:#10BE3B;text-decoration:none;">info@shiproxx.com</a></li>
                    <li>Phone/WhatsApp: +91 98139 81344</li>
                  </ul>
                </div>
                <p style="margin:18px 0 10px;font-size:15px;color:#222;">Happy Shipping! 🚀<br><span style="font-weight:700;">Team Shiproxx</span></p>
              </div>
            </div>
          </td>
        </tr>
      </table>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent:", info.response);
  } catch (error) {
    console.error("Error sending email:", error);
  }
};

// Usage example
// sendWelcomeEmail("bhanjabijayketan@gmail.com","Bijay","Bijay@8984");

module.exports = { sendWelcomeEmail };




