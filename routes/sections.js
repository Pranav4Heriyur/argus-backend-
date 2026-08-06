// routes/sections.js
// Sections (e.g. "Grade 2 - A") within a grade. Creation/editing is
// IT_ADMIN only (SUPER_ADMIN as a fallback, same pattern as almanac.js).
// Everyone with grade/section access can list/read them.

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade, canAccessSection } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/sections?grade_id=2
router.get("/", async (req, res) => {
  const gradeId = req.query.grade_id || req.user.grade_id;
  if (!gradeId) return res.status(400).json({ error: "grade_id is required" });
  if (!canAccessGrade(req.user, gradeId)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  const rows = await db.prepare(`
    SELECT sec.id, sec.name, sec.grade_id, sec.class_teacher_id,
           u.name AS class_teacher_name,
           (SELECT COUNT(*) FROM students st WHERE st.section_id = sec.id) AS student_count
    FROM sections sec
    LEFT JOIN users u ON u.id = sec.class_teacher_id
    WHERE sec.grade_id = ?
    ORDER BY sec.name
  `).all(gradeId);

  res.json(rows);
});

// GET /api/sections/:id
router.get("/:id", async (req, res) => {
  const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(req.params.id);
  if (!section) return res.status(404).json({ error: "Section not found" });
  if (!canAccessSection(req.user, section)) {
    return res.status(403).json({ error: "That section is outside your scope" });
  }
  res.json(section);
});

// POST /api/sections  { grade_id, name, class_teacher_id? }
// IT_ADMIN (or SUPER_ADMIN) only.
router.post("/", requireRole("IT_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const { grade_id, name, class_teacher_id } = req.body || {};
  if (!grade_id || !name) {
    return res.status(400).json({ error: "grade_id and name are required" });
  }

  const grade = await db.prepare("SELECT id FROM grades WHERE id = ?").get(grade_id);
  if (!grade) return res.status(400).json({ error: "Grade not found" });

  if (class_teacher_id) {
    const teacher = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(class_teacher_id);
    if (!teacher || teacher.role !== "TEACHER") {
      return res.status(400).json({ error: "class_teacher_id must be an existing TEACHER" });
    }
  }

  try {
    const info = await db.prepare(`
      INSERT INTO sections (grade_id, name, class_teacher_id, created_by)
      VALUES (?, ?, ?, ?)
    `).run(grade_id, name, class_teacher_id || null, req.user.id);
    const created = await db.prepare("SELECT * FROM sections WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json(created);
  } catch (e) {
    if (String(e.message).includes("duplicate key") || String(e.code) === "23505") {
      return res.status(409).json({ error: `Section "${name}" already exists in this grade` });
    }
    throw e;
  }
});

// PATCH /api/sections/:id  { name?, class_teacher_id? }
// IT_ADMIN (or SUPER_ADMIN) only.
router.patch("/:id", requireRole("IT_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(req.params.id);
  if (!section) return res.status(404).json({ error: "Section not found" });

  const { name, class_teacher_id } = req.body || {};

  if (class_teacher_id !== undefined && class_teacher_id !== null) {
    const teacher = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(class_teacher_id);
    if (!teacher || teacher.role !== "TEACHER") {
      return res.status(400).json({ error: "class_teacher_id must be an existing TEACHER" });
    }
  }

  await db.prepare(`
    UPDATE sections SET
      name = COALESCE(?, name),
      class_teacher_id = ?
    WHERE id = ?
  `).run(
    name || null,
    class_teacher_id === undefined ? section.class_teacher_id : class_teacher_id,
    req.params.id
  );

  res.json(await db.prepare("SELECT * FROM sections WHERE id = ?").get(req.params.id));
});

// DELETE /api/sections/:id
// IT_ADMIN (or SUPER_ADMIN) only. Blocked if students are still assigned.
router.delete("/:id", requireRole("IT_ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(req.params.id);
  if (!section) return res.status(404).json({ error: "Section not found" });

  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM students WHERE section_id = ?").get(req.params.id);
  if (Number(n) > 0) {
    return res.status(409).json({ error: "Move students out of this section before deleting it" });
  }

  await db.prepare("DELETE FROM sections WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
