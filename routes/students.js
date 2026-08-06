// routes/students.js
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const PROFILE_FIELDS = [
  "admission_number", "admission_date", "parent_full_name",
  "contact_phone", "contact_email", "home_address",
  "transport_method", "bus_route", "level",
];

function generatePassword() {
  const words = ["orion", "falcon", "cedar", "harbor", "quartz", "lantern", "meadow", "cobalt"];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// GET /api/students?grade_id=2&section_id=5  (parents get their own children automatically)
router.get("/", async (req, res) => {
  if (req.user.role === "PARENT") {
    return res.json(await db.prepare(`
      SELECT s.*, g.name AS grade_name, sec.name AS section_name FROM students s
      JOIN grades g ON g.id = s.grade_id
      LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.parent_user_id = ?
    `).all(req.user.id));
  }

  const gradeId = req.query.grade_id || req.user.grade_id;
  const sectionId = req.query.section_id;
  if (gradeId && !canAccessGrade(req.user, gradeId)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  if (sectionId) {
    const rows = await db.prepare(`
      SELECT s.*, g.name AS grade_name, sec.name AS section_name FROM students s
      JOIN grades g ON g.id = s.grade_id
      LEFT JOIN sections sec ON sec.id = s.section_id
      WHERE s.section_id = ? ORDER BY s.name
    `).all(sectionId);
    return res.json(rows);
  }

  const sql = gradeId
    ? `SELECT s.*, g.name AS grade_name, sec.name AS section_name FROM students s
       JOIN grades g ON g.id = s.grade_id LEFT JOIN sections sec ON sec.id = s.section_id
       WHERE s.grade_id = ? ORDER BY s.name`
    : `SELECT s.*, g.name AS grade_name, sec.name AS section_name FROM students s
       JOIN grades g ON g.id = s.grade_id LEFT JOIN sections sec ON sec.id = s.section_id
       ORDER BY g.id, s.name`;
  res.json(gradeId ? await db.prepare(sql).all(gradeId) : await db.prepare(sql).all());
});

// GET /api/students/:id  -> full detail, including linked parent account
router.get("/:id", async (req, res) => {
  const student = await db.prepare(`
    SELECT s.*, g.name AS grade_name, sec.name AS section_name FROM students s
    JOIN grades g ON g.id = s.grade_id
    LEFT JOIN sections sec ON sec.id = s.section_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (req.user.role === "PARENT") {
    if (student.parent_user_id !== req.user.id) {
      return res.status(403).json({ error: "You can only view your own child" });
    }
  } else if (!canAccessGrade(req.user, student.grade_id)) {
    return res.status(403).json({ error: "That student is outside your scope" });
  }

  let parentAccount = null;
  if (student.parent_user_id) {
    parentAccount = await db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(student.parent_user_id);
  }
  res.json({ ...student, parent_account: parentAccount });
});

// POST /api/students
// Creates the student AND, if parent details are given, a linked PARENT
// login in one step. Returns the parent's temporary password if created.
router.post("/", requireRole("SUPER_ADMIN", "ADMIN", "COORDINATOR"), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.grade_id) return res.status(400).json({ error: "Child name and grade are required" });
  if (!canAccessGrade(req.user, b.grade_id)) {
    return res.status(403).json({ error: "You can only add students to your own grade" });
  }

  let sectionId = b.section_id || null;
  if (sectionId) {
    const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(sectionId);
    if (!section || Number(section.grade_id) !== Number(b.grade_id)) {
      return res.status(400).json({ error: "section_id must belong to the given grade_id" });
    }
  }

  let parentUserId = b.parent_user_id || null;
  let tempPassword = null;

  // If a login email is provided and no existing parent is linked, make one.
  if (!parentUserId && b.contact_email) {
    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").get(String(b.contact_email).toLowerCase());
    if (existing) {
      parentUserId = existing.id;
    } else {
      tempPassword = generatePassword();
      parentUserId = (await db.prepare(`
        INSERT INTO users (name, email, password_hash, role, created_by)
        VALUES (?, ?, ?, 'PARENT', ?)
      `).run(
        b.parent_full_name || `Parent of ${b.name}`,
        String(b.contact_email).toLowerCase(),
        bcrypt.hashSync(tempPassword, 10),
        req.user.id
      )).lastInsertRowid;
    }
  }

  const cols = ["name", "grade_id", "section_id", "parent_user_id", ...PROFILE_FIELDS];
  const vals = [b.name, b.grade_id, sectionId, parentUserId, ...PROFILE_FIELDS.map((f) => b[f] ?? null)];
  const placeholders = cols.map(() => "?").join(", ");
  const info = await db.prepare(`INSERT INTO students (${cols.join(", ")}) VALUES (${placeholders})`).run(...vals);

  const created = await db.prepare("SELECT * FROM students WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ ...created, parent_temporary_password: tempPassword });
});

// PATCH /api/students/:id  -> update any field, including the full profile
router.patch("/:id", requireRole("SUPER_ADMIN", "ADMIN", "COORDINATOR"), async (req, res) => {
  const student = await db.prepare("SELECT * FROM students WHERE id = ?").get(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });
  if (!canAccessGrade(req.user, student.grade_id)) {
    return res.status(403).json({ error: "That student is outside your scope" });
  }

  const b = req.body || {};

  if (b.section_id !== undefined && b.section_id !== null) {
    const targetGradeId = b.grade_id !== undefined ? b.grade_id : student.grade_id;
    const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(b.section_id);
    if (!section || Number(section.grade_id) !== Number(targetGradeId)) {
      return res.status(400).json({ error: "section_id must belong to the student's grade" });
    }
  }

  const editable = ["name", "grade_id", "section_id", "parent_user_id", ...PROFILE_FIELDS];
  const sets = [];
  const vals = [];
  for (const f of editable) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
  }
  if (sets.length) {
    vals.push(req.params.id);
    await db.prepare(`UPDATE students SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  res.json(await db.prepare("SELECT * FROM students WHERE id = ?").get(req.params.id));
});

// DELETE /api/students/:id
router.delete("/:id", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res) => {
  const info = await db.prepare("DELETE FROM students WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Student not found" });
  res.json({ ok: true });
});

module.exports = router;
