const jwt = require("jsonwebtoken");
const User = require("../models/User.model");
const Role = require("../models/roles.modal");

const isAuthorized = async (req, res, next) => {
  const { authorization } = req.headers;
  // console.log("aut",authorization)

  if (!authorization) {
    return res.status(401).json({
      success: false,
      message: "Authorization header is missing",
    });
  }

  const [Bearer, token] = authorization.split(" ");
  if (Bearer !== "Bearer" || !token) {
    return res.status(401).json({
      success: false,
      message: "Invalid authorization format. Expected 'Bearer <token>'",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.user) {
      // Only load fields that controllers actually need — avoids loading large unused fields
      const user = await User.findById(decoded.user.id).select(
        "_id fullname email phoneNumber userId isAdmin kycDone Wallet creditLimit company"
      );
      // console.log("userrrrr",user)
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      // console.log("user", user);
      req.user = user;
      req.employee = null;
      req.isEmployee = false; // <-- ADD THIS
    } else if (decoded?.employee) {
      // It's an employee
      const employee = await Role.findById(decoded.employee.id).select(
        "_id name email role permissions isActive"
      );
      if (!employee) {
        return res.status(404).json({ success: false, message: "Employee not found" });
      }
      // console.log("employee", employee);
      req.employee = employee;
      
      req.isEmployee = true; // <-- ADD THIS
    } else {
      return res.status(401).json({ success: false, message: "Invalid token payload. Unauthorized access." });
    }

    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

module.exports = { isAuthorized };