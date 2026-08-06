// routes/promotion.js
// Bulk promotion and individual student section/grade changes.
// SUPER_ADMIN / ADMIN / IT_ADMIN / COORDINATOR: full grade scope.
// TEACHER: only their own section (class teacher).

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade, canAccessSection } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// A TEACHER may only touch students who are currently in a section they
// are the class_teacher of. Everyone else falls back to canAccessGrade.
async function canTouchStudent(user, student) {
  if (["SUPER_ADMIN", "ADMIN", "IT_ADMIN", "COORDINATOR"].includes(user.role)) {
    return canAccessGrade(user, student.grade_id);
  }
  if (user.role === "TEACHER") {
    if (!student.section_id) return false;
    const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(student.section_id);
    return section ? canAccessSection(user, section) : false;
  }
  return false;
}

// POST /api/promotion/individual
// Move a single student: change grade and/or section.
// { student_id, new_grade_id?, new_section_id? }
router.post("/individual", requireRole("SUPER_ADMIN", "ADMIN", "IT_ADMIN", "COORDINATOR", "TEACHER"), async (req, res) => {
  const { student_id, new_grade_id, new_section_id } = req.body || {};
  if (!student_id) return res.status(400).json({ error: "student_id is required" });

  const student = await db.prepare("SELECT * FROM students WHERE id = ?").get(student_id);
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (!(await canTouchStudent(req.user, student))) {
    return res.status(403).json({ error: "You don't have access to this student" });
  }

  // Teachers cannot change grade, only section within their own scope.
  if (req.user.role === "TEACHER" && new_grade_id) {
    return res.status(403).json({ error: "Teachers can only change section, not grade. Ask a coordinator/IT admin for grade promotion." });
  }

  const targetGradeId = new_grade_id || student.grade_id;

  if (new_grade_id) {
    const grade = await db.prepare("SELECT id FROM grades WHERE id = ?").get(new_grade_id);
    if (!grade) return res.status(400).json({ error: "Target grade not found" });
    if (!canAccessGrade(req.user, new_grade_id)) {
      return res.status(403).json({ error: "You can only promote within your grade scope" });
    }
  }

  if (new_section_id) {
    const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(new_section_id);
    if (!section || Number(section.grade_id) !== Number(targetGradeId)) {
      return res.status(400).json({ error: "Section does not belong to the target grade" });
    }
    // A teacher may only move a student INTO their own section.
    if (req.user.role === "TEACHER" && !canAccessSection(req.user, section)) {
      return res.status(403).json({ error: "Teachers can only move students into their own section" });
    }
  }

  const updateFields = [];
  const updateValues = [];
  if (new_grade_id) { updateFields.push("grade_id = ?"); updateValues.push(new_grade_id); }
  if (new_section_id !== undefined) { updateFields.push("section_id = ?"); updateValues.push(new_section_id || null); }

  if (updateFields.length === 0) return res.status(400).json({ error: "No changes requested" });

  updateValues.push(student_id);
  await db.prepare(`UPDATE students SET ${updateFields.join(", ")} WHERE id = ?`).run(...updateValues);

  res.json(await db.prepare("SELECT * FROM students WHERE id = ?").get(student_id));
});

// POST /api/promotion/bulk
// Promote all students in a grade to the next grade.
// IT_ADMIN / COORDINATOR / ADMIN / SUPER_ADMIN only (not TEACHER — grade-wide action).
// { from_grade_id, to_grade_id, section_mapping? }  section_mapping: { from_section_id: to_section_id }
router.post("/bulk", requireRole("SUPER_ADMIN", "ADMIN", "IT_ADMIN", "COORDINATOR"), async (req, res) => {
  const { from_grade_id, to_grade_id, section_mapping } = req.body || {};
  if (!from_grade_id || !to_grade_id) {
    return res.status(400).json({ error: "from_grade_id and to_grade_id are required" });
  }
  if (!canAccessGrade(req.user, from_grade_id) || !canAccessGrade(req.user, to_grade_id)) {
    return res.status(403).json({ error: "You can only promote students within your grade scope" });
  }

  const fromGrade = await db.prepare("SELECT id FROM grades WHERE id = ?").get(from_grade_id);
  const toGrade = await db.prepare("SELECT id FROM grades WHERE id = ?").get(to_grade_id);
  if (!fromGrade || !toGrade) return res.status(400).json({ error: "One or both grades do not exist" });

  const students = await db.prepare("SELECT id, section_id FROM students WHERE grade_id = ?").all(from_grade_id);
  if (students.length === 0) return res.status(400).json({ error: "No students in source grade" });

  if (section_mapping) {
    for (const toSectionId of Object.values(section_mapping)) {
      const section = await db.prepare("SELECT grade_id FROM sections WHERE id = ?").get(toSectionId);
      if (!section || Number(section.grade_id) !== Number(to_grade_id)) {
        return res.status(400).json({ error: `Target section ${toSectionId} doesn't belong to target grade` });
      }
    }
  }

  const promoted = [];
  for (const student of students) {
    let newSectionId = null;

    if (section_mapping && student.section_id && section_mapping[student.section_id]) {
      newSectionId = section_mapping[student.section_id];
    } else if (!section_mapping && student.section_id) {
      const oldSection = await db.prepare("SELECT name FROM sections WHERE id = ?").get(student.section_id);
      if (oldSection) {
        const newSection = await db.prepare("SELECT id FROM sections WHERE grade_id = ? AND name = ?").get(to_grade_id, oldSection.name);
        if (newSection) newSectionId = newSection.id;
      }
    }

    await db.prepare("UPDATE students SET grade_id = ?, section_id = ? WHERE id = ?").run(to_grade_id, newSectionId || null, student.id);
    promoted.push({ student_id: student.id, new_grade_id: to_grade_id, new_section_id: newSectionId });
  }

  res.json({ promoted_count: promoted.length, promoted_students: promoted });
});

// GET /api/promotion/preview-bulk?from_grade_id=X&to_grade_id=Y
router.get("/preview-bulk", requireRole("SUPER_ADMIN", "ADMIN", "IT_ADMIN", "COORDINATOR"), async (req, res) => {
  const { from_grade_id, to_grade_id } = req.query;
  if (!from_grade_id || !to_grade_id) {
    return res.status(400).json({ error: "from_grade_id and to_grade_id are required" });
  }
  if (!canAccessGrade(req.user, from_grade_id) || !canAccessGrade(req.user, to_grade_id)) {
    return res.status(403).json({ error: "Grade access denied" });
  }

  const students = await db.prepare(`
    SELECT s.id, s.name, s.grade_id, sec.name AS section_name, sec.id AS section_id
    FROM students s
    LEFT JOIN sections sec ON sec.id = s.section_id
    WHERE s.grade_id = ?
    ORDER BY s.name
  `).all(from_grade_id);

  const preview = [];
  for (const student of students) {
    let newSectionName = "No section";
    if (student.section_id) {
      const sameNameSection = await db.prepare("SELECT name FROM sections WHERE grade_id = ? AND name = ?").get(to_grade_id, student.section_name);
      if (sameNameSection) newSectionName = sameNameSection.name;
    }
    preview.push({
      student_id: student.id,
      student_name: student.name,
      current_section: student.section_name || "No section",
      new_section: newSectionName,
    });
  }

  res.json({ total_students: preview.length, preview });
});

module.exports = router;
