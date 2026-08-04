// routes/users.js
// Account creation and removal. Enforces the pyramid: you can only manage
// roles strictly below your own rank.
//
//   SUPER_ADMIN -> can create ADMIN, IT_ADMIN, COORDINATOR, TEACHER, PARENT
//   ADMIN       -> can create COORDINATOR, TEACHER, PARENT
//   COORDINATOR -> can create TEACHER, PARENT (in their own grade only)

const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const {
  requireAuth,
  requireRole,
  canManageRole,
  canAccessGrade,
} = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// Generates a readable temporary password to hand to the new user.
function generatePassword() {
  const words = ["orion", "falcon", "cedar", "harbor", "quartz", "lantern", "meadow", "cobalt"];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${num}`;
}

// GET /api/users?role=TEACHER&grade_id=2
router.get("/", requireRole("SUPER_ADMIN", "ADMIN", "COORDINATOR"), (req, res) => {
  const { role, grade_id } = req.query;
  let sql = `
    SELECT u.id, u.name, u.email, u.role, u.grade_id, u.subject, u.is_active, u.created_at,
           g.name AS grade_name
    FROM users u LEFT JOIN grades g ON g.id = u.grade_id
    WHERE 1=1
  `;
  const params = [];

  // A coordinator only ever sees their own grade.
  if (req.user.role === "COORDINATOR") {
    sql += " AND u.grade_id = ?";
    params.push(req.user.grade_id);
  } else if (grade_id) {
    sql += " AND u.grade_id = ?";
    params.push(grade_id);
  }

  if (role) {
    sql += " AND u.role = ?";
    params.push(role);
  }

  sql += " ORDER BY u.role, u.name";
  res.json(db.prepare(sql).all(...params));
});

// POST /api/users
// { name, email, role, grade_id?, subject?, password? }
router.post("/", requireRole("SUPER_ADMIN", "ADMIN", "COORDINATOR"), (req, res) => {
  const { name, email, role, grade_id, subject, password } = req.body || {};

  if (!name || !email || !role) {
    return res.status(400).json({ error: "Name, email and role are required" });
  }
  if (!canManageRole(req.user.role, role)) {
    return res.status(403).json({ error: `Your role cannot create a ${role} account` });
  }
  // Coordinators and teachers must be pinned to a grade.
  if ((role === "COORDINATOR" || role === "TEACHER") && !grade_id) {
    return res.status(400).json({ error: `A ${role} must be assigned to a grade` });
  }
  if (grade_id && !canAccessGrade(req.user, grade_id)) {
    return res.status(403).json({ error: "You can only manage accounts in your own grade" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: "That email is already registered" });

  const tempPassword = password || generatePassword();
  const info = db
    .prepare(`
      INSERT INTO users (name, email, password_hash, role, grade_id, subject, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      name,
      String(email).toLowerCase(),
      bcrypt.hashSync(tempPassword, 10),
      role,
      grade_id || null,
      subject || null,
      req.user.id
    );

  res.status(201).json({
    id: info.lastInsertRowid,
    name,
    email: String(email).toLowerCase(),
    role,
    grade_id: grade_id || null,
    subject: subject || null,
    // Shown once so the admin can pass it on. Not recoverable later.
    temporary_password: tempPassword,
  });
});

// PATCH /api/users/:id  { name?, subject?, grade_id?, is_active? }
router.patch("/:id", requireRole("SUPER_ADMIN", "ADMIN", "COORDINATOR"), (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!canManageRole(req.user.role, target.role)) {
    return res.status(403).json({ error: "You cannot modify this account" });
  }

  const { name, subject, grade_id, is_active } = req.body || {};
  db.prepare(`
    UPDATE users SET
      name = COALESCE(?, name),
      subject = COALESCE(?, subject),
      grade_id = COALESCE(?, grade_id),
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    name ?? null,
    subject ?? null,
    grade_id ?? null,
    is_active === undefined ? null : (is_active ? 1 : 0),
    req.params.id
  );

  res.json(db.prepare("SELECT id, name, email, role, grade_id, subject, is_active FROM users WHERE id = ?").get(req.params.id));
});

// DELETE /api/users/:id
// Soft delete by default so historical marks/notices keep their author.
// Pass ?hard=true to remove the row outright (SUPER_ADMIN only).
router.delete("/:id", requireRole("SUPER_ADMIN", "ADMIN"), (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!canManageRole(req.user.role, target.role)) {
    return res.status(403).json({ error: "You cannot remove this account" });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: "You cannot remove your own account" });
  }

  if (req.query.hard === "true" && req.user.role === "SUPER_ADMIN") {
    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    return res.json({ ok: true, removed: "permanently" });
  }

  db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true, removed: "deactivated" });
});

// POST /api/users/:id/reset-password -> returns a fresh temporary password
router.post("/:id/reset-password", requireRole("SUPER_ADMIN", "ADMIN", "COORDINATOR"), (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (!canManageRole(req.user.role, target.role)) {
    return res.status(403).json({ error: "You cannot reset this account" });
  }

  const tempPassword = generatePassword();
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(bcrypt.hashSync(tempPassword, 10), req.params.id);
  res.json({ ok: true, temporary_password: tempPassword });
});

// GET /api/users/grades  (helper for dropdowns)
router.get("/meta/grades", (req, res) => {
  res.json(db.prepare("SELECT * FROM grades ORDER BY id").all());
});

module.exports = router;
