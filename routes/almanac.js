// routes/almanac.js
// Owned by the IT department. Only IT_ADMIN (and SUPER_ADMIN as a fallback)
// can write to it. Everyone signed in can read it.

const express = require("express");
const db = require("../db/db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/almanac?year=2026&month=7   (month is 1-12, both optional)
router.get("/", (req, res) => {
  const { year, month } = req.query;
  let sql = `
    SELECT a.*, u.name AS created_by_name
    FROM almanac_events a
    LEFT JOIN users u ON u.id = a.created_by
    WHERE 1=1
  `;
  const params = [];
  if (year && month) {
    sql += " AND strftime('%Y-%m', a.date) = ?";
    params.push(`${year}-${String(month).padStart(2, "0")}`);
  } else if (year) {
    sql += " AND strftime('%Y', a.date) = ?";
    params.push(String(year));
  }
  sql += " ORDER BY a.date";
  res.json(db.prepare(sql).all(...params));
});

// POST /api/almanac   { date, title, category, note }
router.post("/", requireRole("IT_ADMIN", "SUPER_ADMIN"), (req, res) => {
  const { date, title, category, note } = req.body || {};
  const valid = ["PT1", "PT2", "PT3", "HOLIDAY", "EVENT"];
  if (!date || !title || !category) {
    return res.status(400).json({ error: "date, title and category are required" });
  }
  if (!valid.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${valid.join(", ")}` });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
  }

  const info = db.prepare(`
    INSERT INTO almanac_events (date, title, category, note, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(date, title, category, note || null, req.user.id);

  res.status(201).json(db.prepare("SELECT * FROM almanac_events WHERE id = ?").get(info.lastInsertRowid));
});

// POST /api/almanac/bulk  { events: [ {date,title,category,note}, ... ] }
// Handy for loading a full year of holidays and test dates in one go.
router.post("/bulk", requireRole("IT_ADMIN", "SUPER_ADMIN"), (req, res) => {
  const { events } = req.body || {};
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "events array is required" });
  }
  const insert = db.prepare(`
    INSERT INTO almanac_events (date, title, category, note, created_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((rows) => {
    for (const e of rows) insert.run(e.date, e.title, e.category, e.note || null, req.user.id);
  });
  insertAll(events);
  res.status(201).json({ ok: true, added: events.length });
});

// PATCH /api/almanac/:id
router.patch("/:id", requireRole("IT_ADMIN", "SUPER_ADMIN"), (req, res) => {
  const existing = db.prepare("SELECT * FROM almanac_events WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Event not found" });

  const { date, title, category, note } = req.body || {};
  db.prepare(`
    UPDATE almanac_events SET
      date = COALESCE(?, date),
      title = COALESCE(?, title),
      category = COALESCE(?, category),
      note = COALESCE(?, note)
    WHERE id = ?
  `).run(date ?? null, title ?? null, category ?? null, note ?? null, req.params.id);

  res.json(db.prepare("SELECT * FROM almanac_events WHERE id = ?").get(req.params.id));
});

// DELETE /api/almanac/:id
router.delete("/:id", requireRole("IT_ADMIN", "SUPER_ADMIN"), (req, res) => {
  const info = db.prepare("DELETE FROM almanac_events WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: "Event not found" });
  res.json({ ok: true });
});

module.exports = router;
