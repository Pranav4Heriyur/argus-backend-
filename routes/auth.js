// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db/db");
const { signToken, requireAuth } = require("../middleware/auth");
const { sendResetEmail } = require("../utils/mailer");

const router = express.Router();

const NOW_SQL = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')";

// SECURITY FIX #7: Rate limit login attempts to prevent brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minute window
  max: 5,                      // max 5 login attempts per window
  message: "Too many login attempts. Please try again in 15 minutes.",
  standardHeaders: false,
  legacyHeaders: false,
});

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// POST /api/auth/login  { email, password }
router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password" });
  }
  if (!user.is_active) {
    return res.status(403).json({ error: "This account has been deactivated" });
  }

  res.json({
    token: signToken(user),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      grade_id: user.grade_id,
      subject: user.subject,
    },
  });
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req, res) => {
  const u = req.user;
  const grade = u.grade_id
    ? await db.prepare("SELECT name FROM grades WHERE id = ?").get(u.grade_id)
    : null;
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    grade_id: u.grade_id,
    grade_name: grade ? grade.name : null,
    subject: u.subject,
  });
});

// POST /api/auth/change-password  { current_password, new_password }
router.post("/change-password", requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "Both current and new password are required" });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }
  if (!bcrypt.compareSync(current_password, req.user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ ok: true });
});

// SECURITY FIX #7: Rate limit forgot-password to prevent email spam
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour window
  max: 3,                     // max 3 attempts per hour
  message: "Too many password reset requests. Please try again later.",
  standardHeaders: false,
  legacyHeaders: false,
});

// POST /api/auth/forgot-password  { email }
// Always returns the same generic message, whether or not the email exists,
// so nobody can use this to probe which emails have accounts.
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  const generic = { ok: true, message: "If that email is registered, a reset link has been sent." };
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
  if (!user || !user.is_active) {
    return res.json(generic);
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  await db.prepare(
    `UPDATE users SET reset_token_hash = ?, reset_token_expires = to_char(now() at time zone 'utc' + interval '30 minutes', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`
  ).run(tokenHash, user.id);

  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const resetUrl = `${base}/reset-password.html?token=${rawToken}`;

  let mailResult = { delivered: false };
  try {
    mailResult = await sendResetEmail(user.email, resetUrl);
  } catch (err) {
    console.error("Failed to send reset email:", err.message);
    // Still return the generic message - don't leak whether the account
    // exists, and don't block the response on an email provider hiccup.
  }

  // Demo convenience: when no real SMTP is configured, hand the reset link
  // straight back in the response so it can be shown on screen instead of
  // requiring an actual email inbox. Remove this block before going live
  // with real users, since it would let anyone reset anyone's password.
  if (!mailResult.delivered && process.env.SMTP_USER) {
    // real SMTP is configured but delivery still failed - don't leak the link
    return res.json(generic);
  }
  if (!mailResult.delivered) {
    return res.json({ ...generic, demo_reset_url: resetUrl });
  }

  res.json(generic);
});

// POST /api/auth/reset-password  { token, new_password }
router.post("/reset-password", async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) {
    return res.status(400).json({ error: "Token and new password are required" });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }

  const tokenHash = hashToken(token);
  const user = await db
    .prepare(`SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_expires > ${NOW_SQL}`)
    .get(tokenHash);

  if (!user) {
    return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
  }

  await db.prepare(
    "UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?"
  ).run(bcrypt.hashSync(new_password, 10), user.id);

  res.json({ ok: true });
});

module.exports = router;
