// db.js
// Single SQLite file database. No external DB server to install or manage —
// the whole database lives in argus.sqlite next to this file. Good enough
// for a school-sized deployment; swap for Postgres later by replacing this
// file only, since every route talks to db.js, never to SQLite directly.

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dbPath = path.join(__dirname, "argus.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// better-sqlite3-style transaction helper, since node:sqlite's DatabaseSync
// doesn't ship one. Routes call db.transaction(fn) and then invoke the
// returned function with arguments, same as before.
db.transaction = (fn) => {
  return (...args) => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
};

db.exec(`
CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE          -- e.g. "Grade 2"
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'SUPER_ADMIN', 'ADMIN', 'COORDINATOR', 'TEACHER', 'IT_ADMIN', 'PARENT'
  )),
  grade_id INTEGER REFERENCES grades(id),   -- COORDINATOR/TEACHER: grade they're attached to
  subject TEXT,                             -- TEACHER only, e.g. "Physical Education"
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  test_name TEXT NOT NULL,            -- e.g. "Periodic Test 1", "Term Test 1"
  subject TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  set_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(grade_id, test_name, subject)
);

CREATE TABLE IF NOT EXISTS test_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  subject TEXT NOT NULL,
  test_name TEXT NOT NULL,
  score REAL NOT NULL,
  total REAL NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  status TEXT NOT NULL CHECK (status IN ('PRESENT','ABSENT','LATE','EXCUSED')),
  marked_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(student_id, date)
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  grade_id INTEGER REFERENCES grades(id),   -- NULL = school-wide
  posted_by INTEGER NOT NULL REFERENCES users(id),
  attachment_name TEXT,                     -- original filename, e.g. "circular.pdf"
  attachment_data TEXT,                     -- base64 data URL of the file
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  parent_id INTEGER NOT NULL REFERENCES users(id),
  student_id INTEGER REFERENCES students(id),
  UNIQUE(teacher_id, parent_id, student_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES message_threads(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Managed only by IT_ADMIN (and SUPER_ADMIN as a fallback).
CREATE TABLE IF NOT EXISTS almanac_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('PT1','PT2','PT3','HOLIDAY','EVENT')),
  note TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

-- Syllabus Portion: tentative chapter split per test, editable per grade by
-- that grade's coordinator (or any admin), instead of hardcoded per subject.
CREATE TABLE IF NOT EXISTS syllabus_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_id INTEGER NOT NULL REFERENCES grades(id),
  title TEXT NOT NULL,                -- e.g. "Science Fair Project"
  type TEXT NOT NULL,                 -- e.g. "Project", "Assignment", "Homework"
  due_date TEXT,                      -- YYYY-MM-DD, optional
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-student status against each requirement. One row is created lazily
-- (defaults to PENDING) the first time anyone views/marks it for a student.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL REFERENCES submission_requirements(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUBMITTED','LATE','MISSING')),
  marked_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(requirement_id, student_id)
);
`);

// Migration: add password-reset columns if they don't already exist.
// Safe to run every startup - throws (harmlessly) on repeat runs, which we ignore.
try { db.exec("ALTER TABLE users ADD COLUMN reset_token_hash TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN reset_token_expires TEXT"); } catch (e) {}

module.exports = db;
