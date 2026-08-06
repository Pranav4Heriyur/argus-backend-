// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// SECURITY FIX #6: CORS with allowlist instead of open to all
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: "1mb" }));

// SECURITY FIX #8: HTTPS redirect in production
if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    if (req.header("x-forwarded-proto") !== "https") {
      return res.redirect(`https://${req.header("host")}${req.url}`);
    }
    next();
  });
}

// SECURITY FIX #9: HSTS header for HTTPS enforcement
app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

// SECURITY FIX #1 (CRITICAL): Only serve whitelisted HTML files, not entire directory
// This prevents /db/argus.sqlite and /routes/* from being publicly accessible
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/admin.html", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/index.html", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/reset-password.html", (req, res) => res.sendFile(path.join(__dirname, "reset-password.html")));

// Serve CSS, JS, and image assets (no dotfiles, no db/, no routes/)
app.use(express.static(__dirname, {
  setHeaders: (res, path, stat) => {
    // Deny access to sensitive files/directories
    if (path.includes("db/") || path.includes("routes/") || path.includes("middleware/") || path.includes("utils/")) {
      res.status(404).end();
    }
  },
  dotfiles: "deny",  // Explicitly deny .env, .git, etc.
}));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/students", require("./routes/students"));
app.use("/api/scores", require("./routes/scores"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/sections", require("./routes/sections"));
app.use("/api/classgroup", require("./routes/classgroup"));
app.use("/api/notices", require("./routes/notices"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/almanac", require("./routes/almanac"));
app.use("/api/syllabus", require("./routes/syllabus"));
app.use("/api/submissions", require("./routes/submissions"));
app.use("/api/promotion", require("./routes/promotion"));

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Catch-all 404 for unmapped routes
app.use((req, res) => {
  if (!res.headersSent) {
    res.status(404).json({ error: "Not found" });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

// Wait for the database (tables created / migrations applied) before
// accepting any traffic, so the first request can't race table creation.
const db = require("./db/db");
db.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Argus backend running on http://localhost:${PORT}`);
      console.log(`Admin portal:  http://localhost:${PORT}/admin.html`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server — database not ready:", err);
    process.exit(1);
  });
