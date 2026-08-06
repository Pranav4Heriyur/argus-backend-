// routes/attendance.js
// Teachers mark attendance for their own section. Coordinators (their
// grade, every section) and admins (any grade) can read it. Parents can
// read their own child only.

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade, canAccessSection } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// POST /api/attendance
// { date: "2026-07-24", entries: [{ student_id, status }] }
router.post("/", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
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
    const student = await db.prepare("SELECT grade_id FROM students WHERE id = ?").get(e.student_id);
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
  const saveAll = db.transaction(async (rows) => {
    for (const e of rows) await upsert.run(e.student_id, date, e.status, req.user.id);
  });
  await saveAll(entries);

  res.status(201).json({ ok: true, date, marked: entries.length });
});

// GET /api/attendance?grade_id=2&date=2026-07-24  (staff view: one day, whole grade)
router.get("/", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const gradeId = req.query.grade_id || req.user.grade_id;
  const date = req.query.date;
  if (!gradeId || !date) return res.status(400).json({ error: "grade_id and date are required" });
  if (!canAccessGrade(req.user, gradeId)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  res.json(await db.prepare(`
    SELECT s.id AS student_id, s.name AS student_name, a.status, a.date
    FROM students s
    LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ?
    WHERE s.grade_id = ?
    ORDER BY s.name
  `).all(date, gradeId));
});

// GET /api/attendance/section/:sectionId?date=2026-07-24
// Fast-attendance view for a class teacher: every student in the section,
// defaulted to ABSENT unless already marked otherwise for that date. This
// matches the "mark absent by default, tap to flip" flow.
router.get("/section/:sectionId", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: "date is required" });

  const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(req.params.sectionId);
  if (!section) return res.status(404).json({ error: "Section not found" });
  if (!canAccessSection(req.user, section)) {
    return res.status(403).json({ error: "That section is outside your scope" });
  }

  const rows = await db.prepare(`
    SELECT s.id AS student_id, s.name AS student_name,
           COALESCE(a.status, 'ABSENT') AS status,
           (a.status IS NOT NULL) AS already_marked
    FROM students s
    LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ?
    WHERE s.section_id = ?
    ORDER BY s.name
  `).all(date, req.params.sectionId);

  res.json({ section: { id: section.id, name: section.name, grade_id: section.grade_id }, date, students: rows });
});

// GET /api/attendance/student/:studentId  (summary + recent history)
router.get("/student/:studentId", async (req, res) => {
  const student = await db.prepare("SELECT * FROM students WHERE id = ?").get(req.params.studentId);
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (req.user.role === "PARENT") {
    if (student.parent_user_id !== req.user.id) {
      return res.status(403).json({ error: "You can only view your own child's attendance" });
    }
  } else if (!canAccessGrade(req.user, student.grade_id)) {
    return res.status(403).json({ error: "That student is outside your scope" });
  }

  const records = await db.prepare(
    "SELECT date, status FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 60"
  ).all(req.params.studentId);

  const totals = await db.prepare(`
    SELECT
      COUNT(*) AS total_days,
      SUM(CASE WHEN status IN ('PRESENT','LATE') THEN 1 ELSE 0 END) AS days_present
    FROM attendance WHERE student_id = ?
  `).get(req.params.studentId);

  const totalDays = Number(totals.total_days);
  const daysPresent = Number(totals.days_present);
  const pct = totalDays ? Math.round((daysPresent / totalDays) * 100) : null;

  res.json({
    student: { id: student.id, name: student.name },
    summary: { total_days: totalDays, days_present: daysPresent, attendance_percent: pct },
    recent: records,
  });
});

module.exports = router;
