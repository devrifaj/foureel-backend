require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const connectDB = require("./config/db");
const authRoutes = require("./routes/auth");
const apiRoutes = require("./routes/api");
const { seedTeamUsers } = require("./utils/seedTeamUsers");

const app = express();

const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.PORTAL_URL,

  // hardcoded production fallbacks
  "https://www.4reelagency.nl",
  "https://4reelagency.nl",

  // local dev
  "http://localhost:5173",
  "http://localhost:5174",
].filter(Boolean);

console.log("[CORS_ALLOWED_ORIGINS]", allowedOrigins);

const corsOptions = {
  origin(origin, callback) {
    // allow curl/postman/server-to-server requests
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.error("[CORS_BLOCKED_ORIGIN]", origin);

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// CORS must be before routes
app.use(cors(corsOptions));

// Explicit preflight handler
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    env: process.env.NODE_ENV,
    clientUrl: process.env.CLIENT_URL,
    portalUrl: process.env.PORTAL_URL,
  });
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api", apiRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error("[GLOBAL_ERROR]", err);

  res.status(500).json({
    error: process.env.NODE_ENV === "production" ? "Server error" : err.message,
  });
});

const PORT = process.env.PORT || 3001;

async function bootstrap() {
  try {
    await connectDB();

    if (process.env.NODE_ENV !== "production") {
      try {
        const result = await seedTeamUsers();
        console.log(
          `[seed] Team users ready (${result.createdCount} created, ${result.total} total)`
        );
      } catch (error) {
        console.error("[seed] Failed to seed team users:", error.message);
      }
    }

    app.listen(PORT, () => {
      console.log(`4REEL API running on port ${PORT}`);
    });
  } catch (error) {
    console.error("[BOOTSTRAP_ERROR]", error);
    process.exit(1);
  }
}

bootstrap();