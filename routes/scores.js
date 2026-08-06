// routes/scores.js
// The core rule from the notes: a TEACHER can only upload marks when the
// COORDINATOR for that grade has toggled permission on for that
// grade + test + subject combination.

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const NOW_SQL = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')";

// ---------- Coordinator side: the approval toggle ----------

// GET /api/scores/permissions?grade_id=2
router.get("/permissions", async (req, res) => {
  const gradeId = req.query.grade_id || req.user.grade_id;
  if (!gradeId) return res.status(400).json({ error: "grade_id is required" });
  if (!canAccessGrade(req.user, gradeId)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  res.json(
    await db.prepare(`
      SELECT p.*, g.name AS grade_name, u.name AS set_by_name
      FROM marks_permissions p
      JOIN grades g ON g.id = p.grade_id
      LEFT JOIN users u ON u.id = p.set_by
      WHERE p.grade_id = ?
      ORDER BY p.test_name, p.subject
    `).all(gradeId)
  );
});

// PUT /api/scores/permissions
// { grade_id, test_name, subject, allowed }
// Coordinator (own grade), Admin or Super Admin (any grade).
router.put("/permissions", requireRole("COORDINATOR", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const { grade_id, test_name, subject, allowed } = req.body || {};
  if (!grade_id || !test_name || !subject) {
    return res.status(400).json({ error: "grade_id, test_name and subject are required" });
  }
  if (!canAccessGrade(req.user, grade_id)) {
    return res.status(403).json({ error: "You can only set permissions for your own grade" });
  }

  await db.prepare(`
    INSERT INTO marks_permissions (grade_id, test_name, subject, allowed, set_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ${NOW_SQL})
    ON CONFLICT(grade_id, test_name, subject)
    DO UPDATE SET allowed = excluded.allowed, set_by = excluded.set_by, updated_at = ${NOW_SQL}
  `).run(grade_id, test_name, subject, allowed ? 1 : 0, req.user.id);

  res.json({ ok: true, grade_id, test_name, subject, allowed: allowed ? 1 : 0 });
});

// ---------- Teacher side: uploading marks ----------

async function isUploadAllowed(gradeId, testName, subject) {
  const row = await db.prepare(`
    SELECT allowed FROM marks_permissions
    WHERE grade_id = ? AND test_name = ? AND subject = ?
  `).get(gradeId, testName, subject);
  return !!(row && row.allowed);
}

// GET /api/scores/can-upload?test_name=Term%20Test%201
// Lets the teacher's UI grey out the upload form with a clear reason.
router.get("/can-upload", requireRole("TEACHER"), async (req, res) => {
  const testName = req.query.test_name;
  if (!testName) return res.status(400).json({ error: "test_name is required" });
  const allowed = await isUploadAllowed(req.user.grade_id, testName, req.user.subject);
  res.json({
    allowed,
    reason: allowed
      ? "Approved by your grade coordinator"
      : "Waiting for the grade coordinator to approve uploads for this test",
  });
});

// POST /api/scores
// { test_name, entries: [{ student_id, score, total }] }
// Subject is taken from the teacher's own account, never from the request.
router.post("/", requireRole("TEACHER"), async (req, res) => {
  const { test_name, entries } = req.body || {};
  if (!test_name || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: "test_name and a non-empty entries array are required" });
  }
  if (!req.user.subject) {
    return res.status(400).json({ error: "Your account has no subject assigned. Ask your coordinator to set one." });
  }

  if (!(await isUploadAllowed(req.user.grade_id, test_name, req.user.subject))) {
    return res.status(403).json({
      error: "Uploads are locked for this test. Your grade coordinator has not approved them yet.",
    });
  }

  // Every student must actually belong to this teacher's grade.
  const gradeStudents = await db.prepare("SELECT id FROM students WHERE grade_id = ?").all(req.user.grade_id);
  const gradeStudentIds = new Set(gradeStudents.map((s) => s.id));
  for (const e of entries) {
    if (!gradeStudentIds.has(Number(e.student_id))) {
      return res.status(400).json({ error: `Student ${e.student_id} is not in your grade` });
    }
    if (e.score == null || e.total == null || Number(e.score) < 0 || Number(e.score) > Number(e.total)) {
      return res.status(400).json({ error: `Invalid score for student ${e.student_id}` });
    }
  }

  const insert = db.prepare(`
    INSERT INTO test_scores (student_id, subject, test_name, score, total, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const clearExisting = db.prepare(`
    DELETE FROM test_scores WHERE student_id = ? AND subject = ? AND test_name = ?
  `);

  // One transaction: a re-upload replaces the previous marks cleanly.
  const saveAll = db.transaction(async (rows) => {
    for (const e of rows) {
      await clearExisting.run(e.student_id, req.user.subject, test_name);
      await insert.run(e.student_id, req.user.subject, test_name, e.score, e.total, req.user.id);
    }
  });
  await saveAll(entries);

  res.status(201).json({ ok: true, uploaded: entries.length, subject: req.user.subject, test_name });
});

// ---------- Reading marks ----------

// GET /api/scores/student/:studentId
// Parents may only read their own child. Staff are grade-scoped as usual.
router.get("/student/:studentId", async (req, res) => {
  const student = await db.prepare("SELECT * FROM students WHERE id = ?").get(req.params.studentId);
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (req.user.role === "PARENT") {
    if (student.parent_user_id !== req.user.id) {
      return res.status(403).json({ error: "You can only view your own child's results" });
    }
  } else if (!canAccessGrade(req.user, student.grade_id)) {
    return res.status(403).json({ error: "That student is outside your scope" });
  }

  const scores = await db.prepare(`
    SELECT ts.*, u.name AS uploaded_by_name
    FROM test_scores ts
    LEFT JOIN users u ON u.id = ts.uploaded_by
    WHERE ts.student_id = ?
    ORDER BY ts.test_name, ts.subject
  `).all(req.params.studentId);

  // Grouped by test so the parent app can render it directly.
  const byTest = {};
  for (const s of scores) {
    byTest[s.test_name] = byTest[s.test_name] || [];
    byTest[s.test_name].push({
      subject: s.subject,
      score: s.score,
      total: s.total,
      percent: Math.round((s.score / s.total) * 100),
      uploaded_by: s.uploaded_by_name,
      uploaded_at: s.uploaded_at,
    });
  }

  res.json({ student: { id: student.id, name: student.name }, results: byTest });
});

module.exports = router;
