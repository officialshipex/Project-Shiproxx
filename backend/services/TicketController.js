const Ticket = require('../models/TicketSchema');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Multer configuration for file uploads (multiple files)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Save files in the uploads folder
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Generate unique 10-digit ticket number
const generateTicketNumber = () => {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
};

const createTicket = async (req, res) => {
  try {
    // For multipart/form-data, fields are in req.body, files in req.files
    let {
      category, subcategory, awbType, awbNumbers, fullname, phoneNumber,
      email, isAdmin, company, status, message
    } = req.body;

    // Get userId from auth middleware, not from req.body
    const userId = req.user?._id || req.employee?._id;

    if (!userId || !category || !subcategory || !fullname || !phoneNumber || !email || !company || !message) {
      if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
          try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (e) {}
        });
      }
      return res.status(400).json({ message: "All fields except AWB and attachments are required" });
    }

    const ticketNumber = generateTicketNumber();

    // Parse awbNumbers if present
    if (awbNumbers && typeof awbNumbers === "string") {
      awbNumbers = awbNumbers.split(",").map(awb => awb.trim()).filter(awb => awb.length > 0);
    } else if (!awbNumbers) {
      awbNumbers = [];
    }

    const validStatuses = ["active", "resolved", "deleted"];
    if (status && !validStatuses.includes(status)) {
      if (req.files && req.files.length > 0) {
        req.files.forEach(file => {
          try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (e) {}
        });
      }
      return res.status(400).json({ message: "Invalid status value" });
    }

    // Handle multiple attachments (files/images)
    let attachments = [];
    if (req.files && req.files.length > 0) {
      attachments = req.files.map(file => file.path);
    }

    const newTicket = new Ticket({
      category,
      subcategory,
      awbType,
      awbNumbers,
      ticketNumber,
      fullname,
      phoneNumber,
      userId,
      email,
      isAdmin,
      company,
      message,
      status: status || "active",
      attachments
    });

    await newTicket.save();

    res.status(201).json({ message: "Ticket created successfully", ticket: newTicket });
  } catch (error) {
    console.error("Error creating ticket:", error);
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (e) {}
      });
    }
    res.status(500).json({ message: "Server error" });
  }
};
// Get all tickets
const getAllTickets = async (req, res) => {
  try {
    const tickets = await Ticket.find();
    res.status(200).json(tickets);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

const getUserTickets = async (req, res) => {
  try {
    const userId =req.user?._id || req.employee?._id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized: User not found" });
    }

    const tickets = await Ticket.find({ userId })
    // console.log("Tickets found for user:", tickets);
    res.status(200).json(tickets);
  } catch (error) {
    console.error("Error fetching user tickets:", error);
    res.status(500).json({ message: "Server error" });
  }
};


// Get a single ticket by ID
const getTicketById = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }
    res.status(200).json(ticket);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// Update ticket status
const updateTicketStatus = async (req, res) => {
  try {
    console.log("🔧 PUT /support/:id/status called");
    console.log("Params:", req.params);
    console.log("Body:", req.body);
    console.log("User from auth middleware:", req.user || req.employee);

    const { status } = req.body;
    const validStatuses = ["active", "resolved", "deleted"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const updatedTicket = await Ticket.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!updatedTicket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.status(200).json({ message: "Status updated successfully", ticket: updatedTicket });
  } catch (error) {
    console.error("❌ Error in updateTicketStatus:", error);
    res.status(500).json({ message: "Server error" });
  }
};


// Delete a ticket
const deleteTicket = async (req, res) => {
  try {
    const ticket = await Ticket.findByIdAndDelete(req.params.id);
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }
    res.status(200).json({ message: "Ticket deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  upload,
  createTicket,
  getAllTickets,
  getTicketById,
  getUserTickets,
  updateTicketStatus,
  deleteTicket
};