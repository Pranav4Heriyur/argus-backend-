// routes/submissions.js
// Two things live here:
//  1. Submission requirements - what a coordinator expects their grade's
//     students to turn in (projects, assignments, etc). Set up per grade,
//     since it varies grade to grade.
//  2. A performance view - lets a principal/admin (or a coordinator for
//     their own grade) look up one student and see test-score averages
//     alongside how they're doing against those submission requirements.

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const STAFF_ROLES = ["TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"];
const SETUP_ROLES = ["COORDINATOR", "ADMIN", "SUPER_ADMIN"];

// ---------- Requirements (coordinator sets these up per grade) ----------

// GET /api/submissions/requirements?grade_id=2
router.get("/requirements", requireRole(...STAFF_ROLES), (req, res) => {
  const { grade_id } = req.query;
  if (!grade_id) return res.status(400).json({ error: "grade_id is required" });
  if (!canAccessGrade(req.user, grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }
  res.json(
    db.prepare("SELECT * FROM submission_requirements WHERE grade_id = ? ORDER BY due_date IS NULL, due_date")
      .all(grade_id)
  );
});

// POST /api/submissions/requirements  { grade_id, title, type, due_date }
router.post("/requirements", requireRole(...SETUP_ROLES), (req, res) => {
  const { grade_id, title, type, due_date } = req.body || {};
  if (!grade_id || !title || !type) {
    return res.status(400).json({ error: "grade_id, title and type are required" });
  }
  if (!canAccessGrade(req.user, grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }
  const info = db.prepare(`
    INSERT INTO submission_requirements (grade_id, title, type, due_date, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(grade_id, title, type, due_date || null, req.user.id);

  res.status(201).json(db.prepare("SELECT * FROM submission_requirements WHERE id = ?").get(info.lastInsertRowid));
});

// DELETE /api/submissions/requirements/:id
router.delete("/requirements/:id", requireRole(...SETUP_ROLES), (req, res) => {
  const existing = db.prepare("SELECT * FROM submission_requirements WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Requirement not found" });
  if (!canAccessGrade(req.user, existing.grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }
  db.prepare("DELETE FROM submission_requirements WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// GET /api/submissions/requirements/:id/status
// Every student in that grade, with their current status (defaults to
// PENDING for students who don't have a row yet).
router.get("/requirements/:id/status", requireRole(...STAFF_ROLES), (req, res) => {
  const requirement = db.prepare("SELECT * FROM submission_requirements WHERE id = ?").get(req.params.id);
  if (!requirement) return res.status(404).json({ error: "Requirement not found" });
  if (!canAccessGrade(req.user, requirement.grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  const rows = db.prepare(`
    SELECT s.id AS student_id, s.name,
           COALESCE(sub.status, 'PENDING') AS status
    FROM students s
    LEFT JOIN submissions sub ON sub.student_id = s.id AND sub.requirement_id = ?
    WHERE s.grade_id = ?
    ORDER BY s.name
  `).all(req.params.id, requirement.grade_id);

  res.json({ requirement, students: rows });
});

// POST /api/submissions/requirements/:id/status  { student_id, status }
router.post("/requirements/:id/status", requireRole(...STAFF_ROLES), (req, res) => {
  const requirement = db.prepare("SELECT * FROM submission_requirements WHERE id = ?").get(req.params.id);
  if (!requirement) return res.status(404).json({ error: "Requirement not found" });
  if (!canAccessGrade(req.user, requirement.grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }
  const { student_id, status } = req.body || {};
  const valid = ["PENDING", "SUBMITTED", "LATE", "MISSING"];
  if (!student_id || !valid.includes(status)) {
    return res.status(400).json({ error: `student_id and a status in ${valid.join(", ")} are required` });
  }
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(student_id);
  if (!student || student.grade_id !== requirement.grade_id) {
    return res.status(400).json({ error: "That student is not in this requirement's grade" });
  }

  db.prepare(`
    INSERT INTO submissions (requirement_id, student_id, status, marked_by, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(requirement_id, student_id)
    DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, updated_at = datetime('now')
  `).run(req.params.id, student_id, status, req.user.id);

  res.json({ ok: true });
});

// ---------- Performance view (principal / admin / coordinator) ----------

// GET /api/submissions/performance/grade/:gradeId
// One row per student: test-score average + submission compliance %.
// This is the list a principal/HM browses to pick a student to drill into.
router.get("/performance/grade/:gradeId", requireRole(...SETUP_ROLES), (req, res) => {
  const gradeId = req.params.gradeId;
  if (!canAccessGrade(req.user, gradeId)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  const students = db.prepare("SELECT id, name FROM students WHERE grade_id = ? ORDER BY name").all(gradeId);
  const totalRequirements = db.prepare(
    "SELECT COUNT(*) AS n FROM submission_requirements WHERE grade_id = ?"
  ).get(gradeId).n;

  const result = students.map((s) => {
    const scoreRow = db.prepare(`
      SELECT AVG(CAST(score AS FLOAT) / total * 100) AS avg_pct
      FROM test_scores WHERE student_id = ?
    `).get(s.id);

    const submittedCount = db.prepare(`
      SELECT COUNT(*) AS n FROM submissions
      WHERE student_id = ? AND status IN ('SUBMITTED', 'LATE')
    `).get(s.id).n;

    return {
      student_id: s.id,
      name: s.name,
      avg_score_percent: scoreRow.avg_pct === null ? null : Math.round(scoreRow.avg_pct),
      submissions_completed: submittedCount,
      submissions_total: totalRequirements,
      submission_percent: totalRequirements ? Math.round((submittedCount / totalRequirements) * 100) : null,
    };
  });

  res.json(result);
});

// GET /api/submissions/performance/student/:studentId
// Full drill-down for one student: every test score, and every
// requirement with their status against it.
router.get("/performance/student/:studentId", requireRole(...SETUP_ROLES), (req, res) => {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(req.params.studentId);
  if (!student) return res.status(404).json({ error: "Student not found" });
  if (!canAccessGrade(req.user, student.grade_id)) {
    return res.status(403).json({ error: "That student is outside your scope" });
  }

  const scores = db.prepare(`
    SELECT test_name, subject, score, total FROM test_scores WHERE student_id = ? ORDER BY test_name, subject
  `).all(student.id);

  const requirements = db.prepare(`
    SELECT r.id, r.title, r.type, r.due_date, COALESCE(sub.status, 'PENDING') AS status
    FROM submission_requirements r
    LEFT JOIN submissions sub ON sub.requirement_id = r.id AND sub.student_id = ?
    WHERE r.grade_id = ?
    ORDER BY r.due_date IS NULL, r.due_date
  `).all(student.id, student.grade_id);

  res.json({ student: { id: student.id, name: student.name }, scores, requirements });
});

module.exports = router;
