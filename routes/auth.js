// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("../db/db");
const { signToken, requireAuth } = require("../middleware/auth");
const { sendResetEmail } = require("../utils/mailer");

const router = express.Router();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// POST /api/auth/login  { email, password }
router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
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
router.get("/me", requireAuth, (req, res) => {
  const u = req.user;
  const grade = u.grade_id
    ? db.prepare("SELECT name FROM grades WHERE id = ?").get(u.grade_id)
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
router.post("/change-password", requireAuth, (req, res) => {
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
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(bcrypt.hashSync(new_password, 10), req.user.id);
  res.json({ ok: true });
});

// POST /api/auth/forgot-password  { email }
// Always returns the same generic message, whether or not the email exists,
// so nobody can use this to probe which emails have accounts.
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  const generic = { ok: true, message: "If that email is registered, a reset link has been sent." };
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase());
  if (!user || !user.is_active) {
    return res.json(generic);
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);

  db.prepare(
    "UPDATE users SET reset_token_hash = ?, reset_token_expires = datetime('now', '+30 minutes') WHERE id = ?"
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
router.post("/reset-password", (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) {
    return res.status(400).json({ error: "Token and new password are required" });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }

  const tokenHash = hashToken(token);
  const user = db
    .prepare("SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_expires > datetime('now')")
    .get(tokenHash);

  if (!user) {
    return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
  }

  db.prepare(
    "UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?"
  ).run(bcrypt.hashSync(new_password, 10), user.id);

  res.json({ ok: true });
});

module.exports = router;
