// routes/classgroup.js
// One-way "class group" board, scoped to a single section — separate from
// the school/grade-wide notice board (routes/notices.js). Posted by that
// section's class teacher (or the grade's coordinator / any admin).
// Visible to: that section's parents + its class teacher; coordinator sees
// every section in her grade; admins see everything.

const express = require("express");
const db = require("../db/db");
const { requireAuth, canAccessSection } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

async function parentHasChildInSection(userId, sectionId) {
  const row = await db.prepare(
    "SELECT id FROM students WHERE parent_user_id = ? AND section_id = ?"
  ).get(userId, sectionId);
  return !!row;
}

// GET /api/classgroup/:sectionId
router.get("/:sectionId", async (req, res) => {
  const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(req.params.sectionId);
  if (!section) return res.status(404).json({ error: "Section not found" });

  if (req.user.role === "PARENT") {
    const allowed = await parentHasChildInSection(req.user.id, section.id);
    if (!allowed) return res.status(403).json({ error: "You don't have a child in this section" });
  } else if (!canAccessSection(req.user, section)) {
    return res.status(403).json({ error: "That section is outside your scope" });
  }

  const posts = await db.prepare(`
    SELECT cgp.id, cgp.title, cgp.body, cgp.attachment_name, cgp.created_at,
           u.name AS posted_by_name
    FROM class_group_posts cgp
    JOIN users u ON u.id = cgp.posted_by
    WHERE cgp.section_id = ?
    ORDER BY cgp.created_at DESC
  `).all(req.params.sectionId);

  res.json({ section: { id: section.id, name: section.name, grade_id: section.grade_id }, posts });
});

// POST /api/classgroup/:sectionId  { title, body, attachment_name?, attachment_data? }
// Class teacher of this section, that grade's coordinator, or any admin.
router.post("/:sectionId", async (req, res) => {
  const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(req.params.sectionId);
  if (!section) return res.status(404).json({ error: "Section not found" });
  if (!canAccessSection(req.user, section)) {
    return res.status(403).json({ error: "Only this section's class teacher, its coordinator, or an admin can post here" });
  }

  const { title, body, attachment_name, attachment_data } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: "title and body are required" });

  const info = await db.prepare(`
    INSERT INTO class_group_posts (section_id, title, body, posted_by, attachment_name, attachment_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.sectionId, title, body, req.user.id, attachment_name || null, attachment_data || null);

  const created = await db.prepare(
    "SELECT id, title, body, attachment_name, created_at FROM class_group_posts WHERE id = ?"
  ).get(info.lastInsertRowid);

  res.status(201).json(created);
});

// DELETE /api/classgroup/post/:postId
// Same access rule as posting.
router.delete("/post/:postId", async (req, res) => {
  const post = await db.prepare("SELECT * FROM class_group_posts WHERE id = ?").get(req.params.postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const section = await db.prepare("SELECT * FROM sections WHERE id = ?").get(post.section_id);
  if (!canAccessSection(req.user, section)) {
    return res.status(403).json({ error: "You can't delete this post" });
  }

  await db.prepare("DELETE FROM class_group_posts WHERE id = ?").run(req.params.postId);
  res.json({ ok: true });
});

module.exports = router;
