// routes/attendance.js
// Teachers mark attendance for their own grade. Coordinators and above can
// read it. Parents can read their own child only.

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// POST /api/attendance
// { date: "2026-07-24", entries: [{ student_id, status }] }
router.post("/", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), (req, res) => {
  const { date, entries } = req.body || {};
  if (!date || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: "date and a non-empty entries array are required" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  }

  const valid = ["PRESENT", "ABSENT", "LATE", "EXCUSED"];
  for (const e of entries) {
    if (!valid.includes(e.status)) {
      return res.status(400).json({ error: `Invalid status "${e.status}" for student ${e.student_id}` });
    }
    const student = db.prepare("SELECT grade_id FROM students WHERE id = ?").get(e.student_id);
    if (!student) return res.status(400).json({ error: `Student ${e.student_id} not found` });
    if (!canAccessGrade(req.user, student.grade_id)) {
      return res.status(403).json({ error: `Student ${e.student_id} is outside your grade` });
    }
  }

  const upsert = db.prepare(`
    INSERT INTO attendance (student_id, date, status, marked_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(student_id, date)
    DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by
  `);
  const saveAll = db.transaction((rows) => {
    for (const e of rows) upsert.run(e.student_id, date, e.status, req.user.id);
  });
  saveAll(entries);

  res.status(201).json({ ok: true, date, marked: entries.length });
});

// GET /api/attendance?grade_id=2&date=2026-07-24  (staff view: one day, whole grade)
router.get("/", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), (req, res) => {
  const gradeId = req.query.grade_id || req.user.grade_id;
  const date = req.query.date;
  if (!gradeId || !date) return res.status(400).json({ error: "grade_id and date are required" });
  if (!canAccessGrade(req.user, gradeId)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  res.json(db.prepare(`
    SELECT s.id AS student_id, s.name AS student_name, a.status, a.date
    FROM students s
    LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ?
    WHERE s.grade_id = ?
    ORDER BY s.name
  `).all(date, gradeId));
});

// GET /api/attendance/student/:studentId  (summary + recent history)
router.get("/student/:studentId", (req, res) => {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(req.params.studentId);
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (req.user.role === "PARENT") {
    if (student.parent_user_id !== req.user.id) {
      return res.status(403).json({ error: "You can only view your own child's attendance" });
    }
  } else if (!canAccessGrade(req.user, student.grade_id)) {
    return res.status(403).json({ error: "That student is outside your scope" });
  }

  const records = db.prepare(
    "SELECT date, status FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 60"
  ).all(req.params.studentId);

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_days,
      SUM(CASE WHEN status IN ('PRESENT','LATE') THEN 1 ELSE 0 END) AS days_present
    FROM attendance WHERE student_id = ?
  `).get(req.params.studentId);

  const pct = totals.total_days
    ? Math.round((totals.days_present / totals.total_days) * 100)
    : null;

  res.json({
    student: { id: student.id, name: student.name },
    summary: { ...totals, attendance_percent: pct },
    recent: records,
  });
});

module.exports = router;
