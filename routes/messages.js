// routes/messages.js
// Teacher to parent messaging. A thread is always (teacher, parent, student).
//
// One-way by default: only the teacher side (teacher, that grade's
// coordinator, or an admin) can send. The parent can't reply until the
// teacher flips `two_way_enabled` on for that specific thread (the "alarm"
// toggle in the admin portal). Turning it back off returns the thread to
// one-way; it does not delete anything already sent.

const express = require("express");
const db = require("../db/db");
const { requireAuth, canAccessGrade } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const STAFF_ROLES = ["TEACHER", "COORDINATOR", "ADMIN", "SUPER_ADMIN"];

// A staff member may act as/manage the "teacher side" of a thread if they
// are the teacher on it, or they're a coordinator/admin who can access that
// teacher's grade (same rule used elsewhere for grade-scoped access).
async function canManageThread(user, thread) {
  if (user.id === thread.teacher_id) return true;
  if (user.role === "ADMIN" || user.role === "SUPER_ADMIN") return true;
  if (user.role === "COORDINATOR") {
    const teacher = await db.prepare("SELECT grade_id FROM users WHERE id = ?").get(thread.teacher_id);
    return !!teacher && canAccessGrade(user, teacher.grade_id);
  }
  return false;
}

// GET /api/messages/threads  -> threads the signed-in user is part of
router.get("/threads", async (req, res) => {
  const column = req.user.role === "PARENT" ? "parent_id" : "teacher_id";
  const threads = await db.prepare(`
    SELECT t.id, t.student_id, t.two_way_enabled,
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
router.get("/threads/:id", async (req, res) => {
  const thread = await db.prepare("SELECT * FROM message_threads WHERE id = ?").get(req.params.id);
  if (!thread) return res.status(404).json({ error: "Conversation not found" });
  if (thread.teacher_id !== req.user.id && thread.parent_id !== req.user.id) {
    return res.status(403).json({ error: "This conversation is not yours" });
  }

  res.json(await db.prepare(`
    SELECT m.*, u.name AS sender_name, u.role AS sender_role
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.thread_id = ? ORDER BY m.id
  `).all(req.params.id));
});

// PATCH /api/messages/threads/:id/two-way  { enabled: true|false }
// Flips whether the parent may reply on this thread. Only the thread's
// teacher, that grade's coordinator, or an admin can flip it.
router.patch("/threads/:id/two-way", async (req, res) => {
  const thread = await db.prepare("SELECT * FROM message_threads WHERE id = ?").get(req.params.id);
  if (!thread) return res.status(404).json({ error: "Conversation not found" });
  if (!(await canManageThread(req.user, thread))) {
    return res.status(403).json({ error: "Only this conversation's teacher, coordinator, or an admin can change this" });
  }

  const enabled = !!(req.body || {}).enabled;
  await db.prepare("UPDATE message_threads SET two_way_enabled = ? WHERE id = ?")
    .run(enabled ? 1 : 0, req.params.id);

  res.json({ ok: true, thread_id: Number(req.params.id), two_way_enabled: enabled });
});

// POST /api/messages  { thread_id?, teacher_id?, parent_id?, student_id?, body }
// Pass thread_id to reply, or the three ids to start a new conversation.
router.post("/", async (req, res) => {
  const { thread_id, teacher_id, parent_id, student_id, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: "Message body is required" });

  let threadId = thread_id;

  if (!threadId) {
    // Conversations are always started by staff (teacher, coordinator, or
    // admin), never by a parent — that's what "one-way until enabled"
    // means at the point of first contact too.
    if (!STAFF_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: "Only a teacher can start a conversation" });
    }
    if (!teacher_id || !parent_id) {
      return res.status(400).json({ error: "teacher_id and parent_id are required to start a conversation" });
    }
    if (req.user.id !== Number(teacher_id)) {
      return res.status(403).json({ error: "You must be the teacher on the conversation you are starting" });
    }
    const existing = await db.prepare(`
      SELECT id FROM message_threads
      WHERE teacher_id = ? AND parent_id = ? AND COALESCE(student_id, 0) = COALESCE(?, 0)
    `).get(teacher_id, parent_id, student_id || null);

    threadId = existing
      ? existing.id
      : (await db.prepare(`
          INSERT INTO message_threads (teacher_id, parent_id, student_id) VALUES (?, ?, ?)
        `).run(teacher_id, parent_id, student_id || null)).lastInsertRowid;
  } else {
    const thread = await db.prepare("SELECT * FROM message_threads WHERE id = ?").get(threadId);
    if (!thread) return res.status(404).json({ error: "Conversation not found" });
    if (thread.teacher_id !== req.user.id && thread.parent_id !== req.user.id) {
      return res.status(403).json({ error: "This conversation is not yours" });
    }
    // One-way gate: a parent can only reply once the teacher has switched
    // two-way on for this specific thread.
    if (req.user.id === thread.parent_id && !thread.two_way_enabled) {
      return res.status(403).json({
        error: "This conversation is one-way right now. Ask the teacher to turn on two-way replies.",
      });
    }
  }

  const info = await db.prepare(
    "INSERT INTO messages (thread_id, sender_id, body) VALUES (?, ?, ?)"
  ).run(threadId, req.user.id, String(body).trim());

  res.status(201).json({
    ok: true,
    thread_id: threadId,
    message: await db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid),
  });
});

module.exports = router;
