require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const connectDB = require("./config/db");
const authRoutes = require("./routes/auth");
const apiRoutes = require("./routes/api");
const { seedTeamUsers } = require("./utils/seedTeamUsers");

const app = express();

// Middleware
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL,
      process.env.PORTAL_URL,
      "http://localhost:5173",
      "http://localhost:5174",
    ],
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api", apiRoutes);

// Health check
app.get("/health", (req, res) =>
  res.json({ status: "ok", env: process.env.NODE_ENV }),
);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res
    .status(500)
    .json({
      error:
        process.env.NODE_ENV === "production" ? "Server error" : err.message,
    });
});

const PORT = process.env.PORT || 3001;

async function bootstrap() {
  await connectDB();

  if (process.env.NODE_ENV !== "production") {
    try {
      const result = await seedTeamUsers();
      console.log(
        `[seed] Team users ready (${result.createdCount} created, ${result.total} total)`,
      );
    } catch (error) {
      console.error("[seed] Failed to seed team users:", error.message);
    }
  }

  app.listen(PORT, () => console.log(`4REEL API running on port ${PORT}`));
}

bootstrap();
