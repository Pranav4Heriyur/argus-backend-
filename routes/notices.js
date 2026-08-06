// routes/notices.js
// Teachers and above post notices. Parents read notices for their child's
// grade plus school-wide ones, which is exactly what the parent app expects.

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole, canAccessGrade } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/notices
// Parents get their child's grade + school-wide, automatically.
// Staff can pass ?grade_id= to look at a specific grade.
router.get("/", async (req, res) => {
  // Note: attachment_data is deliberately excluded here so the list stays
  // light. A has_attachment flag tells the UI whether to show a download link.
  let sql = `
    SELECT n.id, n.title, n.body, n.category, n.grade_id, n.posted_by,
           n.attachment_name, n.created_at,
           (n.attachment_data IS NOT NULL) AS has_attachment,
           g.name AS grade_name, u.name AS posted_by_name
    FROM notices n
    LEFT JOIN grades g ON g.id = n.grade_id
    LEFT JOIN users u ON u.id = n.posted_by
    WHERE 1=1
  `;
  const params = [];

  if (req.user.role === "PARENT") {
    const child = await db.prepare("SELECT grade_id FROM students WHERE parent_user_id = ?").get(req.user.id);
    sql += " AND (n.grade_id IS NULL OR n.grade_id = ?)";
    params.push(child ? child.grade_id : -1);
  } else if (req.query.grade_id) {
    sql += " AND (n.grade_id IS NULL OR n.grade_id = ?)";
    params.push(req.query.grade_id);
  }

  if (req.query.category) {
    sql += " AND n.category = ?";
    params.push(req.query.category);
  }

  sql += " ORDER BY n.created_at DESC";
  res.json(await db.prepare(sql).all(...params));
});

// POST /api/notices  { title, body, category, grade_id, attachment_name?, attachment_data? }
// grade_id null means school-wide, which only ADMIN and up may post.
// attachment_data is a base64 data URL (e.g. a PDF the school wants to share).
router.post("/", requireRole("TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN", "IT_ADMIN"), async (req, res) => {
  const { title, body, category, grade_id, attachment_name, attachment_data } = req.body || {};
  if (!title || !body || !category) {
    return res.status(400).json({ error: "title, body and category are required" });
  }

  if (!grade_id && !["ADMIN", "SUPER_ADMIN", "IT_ADMIN"].includes(req.user.role)) {
    return res.status(403).json({ error: "Only an admin can post a school-wide notice" });
  }
  if (grade_id && !canAccessGrade(req.user, grade_id)) {
    return res.status(403).json({ error: "You can only post notices for your own grade" });
  }
  
  // SECURITY FIX #5: Stricter file upload validation
  if (attachment_data) {
    // Base64 strings are ~133% of binary size. Estimate and enforce 3 MB limit.
    const estimatedBinarySize = Math.ceil(attachment_data.length * 0.75);
    if (estimatedBinarySize > 3_000_000) {
      return res.status(413).json({ error: "File is too large. Maximum 3 MB." });
    }
    // Validate it's actually a proper base64 data URL
    if (!attachment_data.match(/^data:(application|image)\/[a-zA-Z0-9\-\.+]+;base64,/)) {
      return res.status(400).json({ error: "Attachment must be a valid data URL in format: data:type/subtype;base64,..." });
    }
  }

  const info = await db.prepare(`
    INSERT INTO notices (title, body, category, grade_id, posted_by, attachment_name, attachment_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, body, category, grade_id || null, req.user.id, attachment_name || null, attachment_data || null);

  res.status(201).json(await db.prepare("SELECT id, title, body, category, grade_id, attachment_name FROM notices WHERE id = ?").get(info.lastInsertRowid));
});

// GET /api/notices/:id/attachment -> the base64 data URL for download.
// Access follows the same grade rules as reading the notice itself.
router.get("/:id/attachment", async (req, res) => {
  const notice = await db.prepare("SELECT * FROM notices WHERE id = ?").get(req.params.id);
  if (!notice || !notice.attachment_data) {
    return res.status(404).json({ error: "No attachment on this notice" });
  }
  if (req.user.role === "PARENT") {
    const child = await db.prepare("SELECT grade_id FROM students WHERE parent_user_id = ?").get(req.user.id);
    const allowed = notice.grade_id === null || (child && notice.grade_id === child.grade_id);
    if (!allowed) return res.status(403).json({ error: "This notice is not for your child's grade" });
  }
  res.json({
    name: notice.attachment_name,
    data: notice.attachment_data,
  });
});

// DELETE /api/notices/:id  (author, or any admin)
router.delete("/:id", async (req, res) => {
  const notice = await db.prepare("SELECT * FROM notices WHERE id = ?").get(req.params.id);
  if (!notice) return res.status(404).json({ error: "Notice not found" });

  const isAuthor = notice.posted_by === req.user.id;
  const isAdmin = ["ADMIN", "SUPER_ADMIN", "COORDINATOR"].includes(req.user.role);
  if (!isAuthor && !isAdmin) {
    return res.status(403).json({ error: "You can only remove your own notices" });
  }

  await db.prepare("DELETE FROM notices WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
