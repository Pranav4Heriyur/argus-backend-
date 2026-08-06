// routes/syllabus.js
// Tentative chapter split per test, per grade, per subject. Coordinators
// manage it for their own grade; admins/super admins can manage any grade.
// Everyone signed in can read it (parents read their child's grade only,
// enforced on the front end + by always requiring a grade_id filter here).

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/syllabus?grade_id=2
router.get("/", async (req, res) => {
  const { grade_id } = req.query;
  if (!grade_id) return res.status(400).json({ error: "grade_id is required" });

  const rows = await db.prepare(`
    SELECT * FROM syllabus_chapters WHERE grade_id = ? ORDER BY subject, test_name, sort_order
  `).all(grade_id);
  res.json(rows);
});

// POST /api/syllabus  { grade_id, subject, test_name, chapter_name, sort_order }
router.post("/", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const { grade_id, subject, test_name, chapter_name, sort_order } = req.body || {};
  if (!grade_id || !subject || !test_name || !chapter_name) {
    return res.status(400).json({ error: "grade_id, subject, test_name and chapter_name are required" });
  }
  if (!canAccessGrade(req.user, grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  const info = await db.prepare(`
    INSERT INTO syllabus_chapters (grade_id, subject, test_name, chapter_name, sort_order, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(grade_id, subject, test_name, chapter_name, sort_order ?? 0, req.user.id);

  res.status(201).json(await db.prepare("SELECT * FROM syllabus_chapters WHERE id = ?").get(info.lastInsertRowid));
});

// PATCH /api/syllabus/:id
router.patch("/:id", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const existing = await db.prepare("SELECT * FROM syllabus_chapters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Chapter not found" });
  if (!canAccessGrade(req.user, existing.grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }

  const { subject, test_name, chapter_name, sort_order } = req.body || {};
  await db.prepare(`
    UPDATE syllabus_chapters SET
      subject = COALESCE(?, subject),
      test_name = COALESCE(?, test_name),
      chapter_name = COALESCE(?, chapter_name),
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).run(subject ?? null, test_name ?? null, chapter_name ?? null, sort_order ?? null, req.params.id);

  res.json(await db.prepare("SELECT * FROM syllabus_chapters WHERE id = ?").get(req.params.id));
});

// DELETE /api/syllabus/:id
router.delete("/:id", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"), async (req, res) => {
  const existing = await db.prepare("SELECT * FROM syllabus_chapters WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Chapter not found" });
  if (!canAccessGrade(req.user, existing.grade_id)) {
    return res.status(403).json({ error: "That grade is outside your scope" });
  }
  await db.prepare("DELETE FROM syllabus_chapters WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
