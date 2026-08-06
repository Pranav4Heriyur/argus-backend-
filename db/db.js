// db.js
// Postgres-backed database (Render free Postgres). Kept the same
// db.prepare(sql).run()/.get()/.all() shape the routes already used with
// SQLite, so query code barely changes — the adapter below translates "?"
// placeholders to Postgres's "$1,$2..." style and auto-appends RETURNING id
// on plain INSERTs so `.lastInsertRowid` keeps working.
//
// NOTE: db.transaction(fn) here is a best-effort sequential runner, not a
// real atomic Postgres transaction (each statement still goes through the
// pool independently). Good enough for this app's low-traffic batch writes
// (e.g. saving a class's attendance); it is not a strict all-or-nothing
// guarantee. Fine for a short-lived deployment; revisit if this becomes
// a real production system.

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Add a Render Postgres database and link it " +
    "(render.yaml already does this via fromDatabase), or set DATABASE_URL locally."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = toPgSql(sql);
  const isPlainInsert = /^\s*INSERT/i.test(sql) && !/RETURNING/i.test(sql);
  const runSql = isPlainInsert ? `${pgSql} RETURNING id` : pgSql;

  return {
    async run(...params) {
      const result = await pool.query(runSql, params);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined,
      };
    },
    async get(...params) {
      const result = await pool.query(pgSql, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await pool.query(pgSql, params);
      return result.rows;
    },
  };
}

async function exec(sql) {
  await pool.query(sql);
}

// See NOTE above — sequential, not a true atomic transaction.
function transaction(fn) {
  return async (...args) => {
    return await fn(...args);
  };
}

const db = { prepare, exec, transaction, pool };

async function init() {
  await exec(`
CREATE TABLE IF NOT EXISTS grades (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE          -- e.g. "Grade 2"
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'SUPER_ADMIN', 'ADMIN', 'COORDINATOR', 'TEACHER', 'IT_ADMIN', 'PARENT'
  )),
  grade_id INTEGER REFERENCES grades(id),   -- COORDINATOR/TEACHER: grade they're attached to
  subject TEXT,                             -- TEACHER only, e.g. "Physical Education"
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  created_by INTEGER REFERENCES users(id)
);

-- Sections within a grade (e.g. Grade 2 - Section A). Created by that
-- grade's coordinator or by IT admin (any grade). class_teacher_id is the
-- teacher whose "class group" this section maps to, for fast attendance.
CREATE TABLE IF NOT EXISTS sections (
  id SERIAL PRIMARY KEY,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  name TEXT NOT NULL,                       -- e.g. "A", "B"
  class_teacher_id INTEGER REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(grade_id, name)
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  section_id INTEGER REFERENCES sections(id),
  parent_user_id INTEGER REFERENCES users(id),
  -- Full profile, shown on the student detail page in the admin portal
  admission_number TEXT,
  admission_date TEXT,                      -- YYYY-MM-DD
  parent_full_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  home_address TEXT,
  transport_method TEXT,                    -- e.g. "School Bus", "Own Transport"
  bus_route TEXT,                           -- when transport_method is a bus
  level TEXT                                -- optional label shown in the parent app header
);

-- A teacher may only upload marks for a given grade + test once a
-- coordinator has switched this toggle on. This is the "sub admin
-- permits (toggle option)" rule from the notes.
CREATE TABLE IF NOT EXISTS marks_permissions (
  id SERIAL PRIMARY KEY,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  test_name TEXT NOT NULL,            -- e.g. "Periodic Test 1", "Term Test 1"
  subject TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  set_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(grade_id, test_name, subject)
);

CREATE TABLE IF NOT EXISTS test_scores (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  subject TEXT NOT NULL,
  test_name TEXT NOT NULL,
  score REAL NOT NULL,
  total REAL NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  status TEXT NOT NULL CHECK (status IN ('PRESENT','ABSENT','LATE','EXCUSED')),
  marked_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(student_id, date)
);

CREATE TABLE IF NOT EXISTS notices (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  grade_id INTEGER REFERENCES grades(id),   -- NULL = school-wide
  posted_by INTEGER NOT NULL REFERENCES users(id),
  attachment_name TEXT,                     -- original filename, e.g. "circular.pdf"
  attachment_data TEXT,                     -- base64 data URL of the file
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- One-way "class group" board, scoped to a single section (separate from
-- the school/grade-wide notice board above). Posted by that section's
-- class teacher (or the grade's coordinator / any admin). Visible to that
-- section's parents + teacher; coordinator sees every section in her grade.
CREATE TABLE IF NOT EXISTS class_group_posts (
  id SERIAL PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  posted_by INTEGER NOT NULL REFERENCES users(id),
  attachment_name TEXT,
  attachment_data TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- Teacher -> parent messaging is one-way by default: only the teacher (or
-- that grade's coordinator/an admin) can send until the teacher flips
-- two_way_enabled on for this specific thread, after which the parent may
-- reply too. Toggling back off returns the thread to one-way.
CREATE TABLE IF NOT EXISTS message_threads (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  parent_id INTEGER NOT NULL REFERENCES users(id),
  student_id INTEGER REFERENCES students(id),
  two_way_enabled INTEGER NOT NULL DEFAULT 0,
  UNIQUE(teacher_id, parent_id, student_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES message_threads(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- Managed only by IT_ADMIN (and SUPER_ADMIN as a fallback).
CREATE TABLE IF NOT EXISTS almanac_events (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('PT1','PT2','PT3','HOLIDAY','EVENT')),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

-- Syllabus Portion: tentative chapter split per test, editable per grade by
-- that grade's coordinator (or any admin), instead of hardcoded per subject.
CREATE TABLE IF NOT EXISTS syllabus_chapters (
  id SERIAL PRIMARY KEY,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  subject TEXT NOT NULL,
  test_name TEXT NOT NULL,            -- e.g. "PT1", "PT2", "PT3 (Term Test 1)"
  chapter_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

-- Submission requirements: what a coordinator expects students in their
-- grade to turn in (projects, assignments, etc). Varies per grade, hence
-- owned by the coordinator of that grade (or an admin).
CREATE TABLE IF NOT EXISTS submission_requirements (
  id SERIAL PRIMARY KEY,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  title TEXT NOT NULL,                -- e.g. "Science Fair Project"
  type TEXT NOT NULL,                 -- e.g. "Project", "Assignment", "Homework"
  due_date TEXT,                      -- YYYY-MM-DD, optional
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
);

-- Per-student status against each requirement. One row is created lazily
-- (defaults to PENDING) the first time anyone views/marks it for a student.
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  requirement_id INTEGER NOT NULL REFERENCES submission_requirements(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUBMITTED','LATE','MISSING')),
  marked_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(requirement_id, student_id)
);
`);

  // Migration: add password-reset columns if they don't already exist.
  await exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT");
  await exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TEXT");

  // Migration: one-way-by-default messaging toggle, added after threads
  // already existed in production (existing threads stay one-way).
  await exec("ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS two_way_enabled INTEGER NOT NULL DEFAULT 0");
}

db.ready = init().catch((err) => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});

module.exports = db;
