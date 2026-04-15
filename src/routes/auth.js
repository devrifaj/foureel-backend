const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User, Client } = require("../models");
const auth = require("../middleware/auth");
const { seedTeamUsers } = require("../utils/seedTeamUsers");

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const sign = (user) =>
  jwt.sign(
    {
      id: user._id,
      role: user.role,
      name: user.name,
      clientId: user.clientId || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );

async function verifyPassword(inputPassword, storedHashOrLegacyValue) {
  try {
    const bcryptMatch = await bcrypt.compare(inputPassword, storedHashOrLegacyValue);
    if (bcryptMatch) return true;
  } catch {
    // Ignore invalid hash formats and continue with legacy fallback.
  }
  return (
    typeof storedHashOrLegacyValue === "string" &&
    storedHashOrLegacyValue === inputPassword
  );
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const rawEmail = req.body?.email;
    const rawPassword = typeof req.body?.password === "string" ? req.body.password : "";
    const email = normalizeEmail(rawEmail);
    const password = rawPassword.trim();
    if (!email || !password || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    let user = await User.findOne({ email });
    let legacyClient = null;

    // Backward compatibility:
    // allow client login using either portalEmail or the client's contact email.
    if (!user) {
      legacyClient = await Client.findOne({
        $or: [{ portalEmail: email }, { email }],
      });

      // If a portal user already exists for this client, validate against it first.
      if (legacyClient) {
        user = await User.findOne({ clientId: legacyClient._id, role: "client" });
        if (user) {
          const existingUserMatch = await verifyPassword(password, user.passwordHash);
          if (!existingUserMatch) {
            return res.status(401).json({ error: "Invalid credentials" });
          }
        }
      }
    }

    // Backward-compatibility migration path:
    // if a portal User record doesn't exist yet, authenticate from hashed Client.portalPassword once,
    // then create the proper User document.
    if (!user) {
      legacyClient = legacyClient || (await Client.findOne({ portalEmail: email }));
      if (!legacyClient || !legacyClient.portalPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const legacyMatch = await verifyPassword(password, legacyClient.portalPassword);
      if (!legacyMatch) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      user = await User.create({
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role: "client",
        name: legacyClient.name,
        clientId: legacyClient._id,
      });

      if (legacyClient.portalPassword) {
        legacyClient.portalPassword = undefined;
        await legacyClient.save();
      }
    } else {
      const match = await verifyPassword(password, user.passwordHash);
      if (!match) return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = sign(user);
    res.cookie("token", token, COOKIE_OPTIONS);

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
  res.clearCookie("token", COOKIE_OPTIONS);
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
