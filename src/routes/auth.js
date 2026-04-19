const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User, Client } = require("../models");
const auth = require("../middleware/auth");
const { seedTeamUsers } = require("../utils/seedTeamUsers");

const router = express.Router();

const COOKIE_BASE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};

/** Use when setting the auth cookie (includes maxAge). */
const COOKIE_OPTIONS = {
  ...COOKIE_BASE,
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

/** Client portal login can use this email (User client or legacy Client portal). */
async function findEligibleClientPortalIdentity(normalizedEmail) {
  const user = await User.findOne({ email: normalizedEmail, role: "client" });
  if (user) {
    const client = user.clientId ? await Client.findById(user.clientId) : null;
    return { user, client };
  }

  const client = await Client.findOne({
    $or: [{ portalEmail: normalizedEmail }, { email: normalizedEmail }],
  });
  if (!client) return null;

  const portalUser = await User.findOne({ clientId: client._id, role: "client" });
  if (portalUser) return { user: portalUser, client };

  if (client.portalPassword) return { user: null, client };

  return null;
}

function clientAppBaseUrl() {
  const raw =
    process.env.CLIENT_URL ||
    process.env.PORTAL_URL ||
    "http://localhost:5173";
  return String(raw).replace(/\/$/, "");
}

const MIN_RESET_PASSWORD_LEN = 8;

function verifyClientResetJwt(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.purpose !== "client_password_reset") return null;
    return decoded;
  } catch {
    return null;
  }
}

// GET /api/auth/reset-password/validate?token= — returns { valid: true|false } (always 200).
router.get("/reset-password/validate", (req, res) => {
  const token = req.query.token;
  const decoded = verifyClientResetJwt(token);
  res.json({ valid: Boolean(decoded) });
});

// POST /api/auth/reset-password — body: { token, password, confirmPassword }
router.post("/reset-password", async (req, res) => {
  try {
    const token = req.body?.token;
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const confirmPassword =
      typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "";

    const decoded = verifyClientResetJwt(token);
    if (!decoded) {
      return res.status(400).json({ error: "Invalid or expired reset link" });
    }

    if (password.length < MIN_RESET_PASSWORD_LEN) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_RESET_PASSWORD_LEN} characters` });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    const hash = await bcrypt.hash(password, 10);

    if (decoded.uid) {
      const user = await User.findById(decoded.uid);
      if (!user || user.role !== "client") {
        return res.status(400).json({ error: "Invalid or expired reset link" });
      }
      user.passwordHash = hash;
      await user.save();
      return res.json({ ok: true });
    }

    if (decoded.clientId && decoded.email) {
      const email = normalizeEmail(decoded.email);
      const client = await Client.findById(decoded.clientId);
      if (!client) {
        return res.status(400).json({ error: "Invalid or expired reset link" });
      }
      const portalEm = normalizeEmail(client.portalEmail || "");
      const contactEm = normalizeEmail(client.email || "");
      if (email !== portalEm && email !== contactEm) {
        return res.status(400).json({ error: "Invalid or expired reset link" });
      }

      let user = await User.findOne({ clientId: client._id, role: "client" });
      if (user) {
        user.passwordHash = hash;
        await user.save();
      } else {
        user = await User.create({
          email,
          passwordHash: hash,
          role: "client",
          name: client.name,
          clientId: client._id,
        });
      }

      if (client.portalPassword) {
        client.portalPassword = undefined;
        await client.save();
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Invalid or expired reset link" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/forgot-password — client portal only; email sending not implemented (URL logged server-side).
router.post("/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const identity = await findEligibleClientPortalIdentity(email);
    if (identity) {
      const tokenPayload =
        identity.user != null
          ? { uid: String(identity.user._id) }
          : { clientId: String(identity.client._id), email };
      const token = jwt.sign(
        { ...tokenPayload, purpose: "client_password_reset" },
        process.env.JWT_SECRET,
        { expiresIn: "1h" },
      );
      const url = `${clientAppBaseUrl()}/login?reset=${encodeURIComponent(token)}`;
      console.log(
        "[auth/forgot-password] Password reset URL (email not sent yet):",
        url,
      );
    }

    res.json({
      ok: true,
      message:
        "If a portal account exists for this email, reset instructions will be sent.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
  res.clearCookie("token", COOKIE_BASE);
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
