const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User, Client } = require("../models");
const auth = require("../middleware/auth");
const { seedTeamUsers } = require("../utils/seedTeamUsers");

const router = express.Router();

const sign = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, name: user.name, clientId: user.clientId },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = sign(user);
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // If client, load their data
    let clientData = null;
    if (user.role === "client" && user.clientId) {
      clientData = await Client.findById(user.clientId);
    }

    res.json({
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        email: user.email,
        clientId: user.clientId,
      },
      clientData,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out" });
});

// GET /api/auth/me
router.get("/me", auth(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-passwordHash");
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/seed — run once to create initial users (disable in production)
router.post("/seed", async (req, res) => {
  if (process.env.NODE_ENV === "production")
    return res.status(403).json({ error: "Disabled in production" });
  try {
    const result = await seedTeamUsers();
    res.json({
      message: "Team users seeded",
      created: result.createdCount,
      total: result.total,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
