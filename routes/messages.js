// routes/messages.js
// Teacher to parent messaging. A thread is always (teacher, parent, student).

const express = require("express");
const db = require("../db/db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/messages/threads  -> threads the signed-in user is part of
router.get("/threads", (req, res) => {
  const column = req.user.role === "PARENT" ? "parent_id" : "teacher_id";
  const threads = db.prepare(`
    SELECT t.id, t.student_id,
           te.name AS teacher_name, te.subject AS teacher_subject,
           pa.name AS parent_name,
           st.name AS student_name,
           (SELECT body FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_at
    FROM message_threads t
    JOIN users te ON te.id = t.teacher_id
    JOIN users pa ON pa.id = t.parent_id
    LEFT JOIN students st ON st.id = t.student_id
    WHERE t.${column} = ?
    ORDER BY last_at DESC
  `).all(req.user.id);
  res.json(threads);
});

// GET /api/messages/threads/:id
router.get("/threads/:id", (req, res) => {
  const thread = db.prepare("SELECT * FROM message_threads WHERE id = ?").get(req.params.id);
  if (!thread) return res.status(404).json({ error: "Conversation not found" });
  if (thread.teacher_id !== req.user.id && thread.parent_id !== req.user.id) {
    return res.status(403).json({ error: "This conversation is not yours" });
  }

  res.json(db.prepare(`
    SELECT m.*, u.name AS sender_name, u.role AS sender_role
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.thread_id = ? ORDER BY m.id
  `).all(req.params.id));
});

// POST /api/messages  { thread_id?, teacher_id?, parent_id?, student_id?, body }
// Pass thread_id to reply, or the three ids to start a new conversation.
router.post("/", (req, res) => {
  const { thread_id, teacher_id, parent_id, student_id, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: "Message body is required" });

  let threadId = thread_id;

  if (!threadId) {
    if (!teacher_id || !parent_id) {
      return res.status(400).json({ error: "teacher_id and parent_id are required to start a conversation" });
    }
    if (req.user.id !== Number(teacher_id) && req.user.id !== Number(parent_id)) {
      return res.status(403).json({ error: "You must be part of the conversation you are starting" });
    }
    const existing = db.prepare(`
      SELECT id FROM message_threads
      WHERE teacher_id = ? AND parent_id = ? AND IFNULL(student_id, 0) = IFNULL(?, 0)
    `).get(teacher_id, parent_id, student_id || null);

    threadId = existing
      ? existing.id
      : db.prepare(`
          INSERT INTO message_threads (teacher_id, parent_id, student_id) VALUES (?, ?, ?)
        `).run(teacher_id, parent_id, student_id || null).lastInsertRowid;
  } else {
    const thread = db.prepare("SELECT * FROM message_threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "Conversation not found" });
    if (thread.teacher_id !== req.user.id && thread.parent_id !== req.user.id) {
      return res.status(403).json({ error: "This conversation is not yours" });
    }
  }

  const info = db.prepare(
    "INSERT INTO messages (thread_id, sender_id, body) VALUES (?, ?, ?)"
  ).run(threadId, req.user.id, String(body).trim());

  res.status(201).json({
    ok: true,
    thread_id: threadId,
    message: db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid),
  });
});

module.exports = router;
