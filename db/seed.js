// db/seed.js
// Creates grades, a starting SUPER_ADMIN, and a small demo school with full
// student profiles, marks, attendance, notices and messages, so both the
// admin portal and the parent app have real data to show immediately.

const bcrypt = require("bcryptjs");
const db = require("./db");

console.log("Seeding database...");

db.exec(`
  DELETE FROM messages; DELETE FROM message_threads;
  DELETE FROM test_scores; DELETE FROM marks_permissions;
  DELETE FROM attendance; DELETE FROM notices;
  DELETE FROM almanac_events; DELETE FROM students;
  DELETE FROM submissions; DELETE FROM submission_requirements;
  DELETE FROM syllabus_chapters;
  DELETE FROM users; DELETE FROM grades;
`);

const insertGrade = db.prepare("INSERT INTO grades (name) VALUES (?)");
for (let i = 1; i <= 12; i++) insertGrade.run(`Grade ${i}`);

const hash = (p) => bcrypt.hashSync(p, 10);
const insertUser = db.prepare(`
  INSERT INTO users (name, email, password_hash, role, grade_id, subject)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const superAdminId = insertUser.run("Super Admin", "superadmin@argus.school", hash("super1234"), "SUPER_ADMIN", null, null).lastInsertRowid;
insertUser.run("Principal Sharma", "principal@argus.school", hash("admin1234"), "ADMIN", null, null);
const itId = insertUser.run("IT Department", "it@argus.school", hash("itadmin1234"), "IT_ADMIN", null, null).lastInsertRowid;

const grade2 = db.prepare("SELECT id FROM grades WHERE name = 'Grade 2'").get().id;
const grade12 = db.prepare("SELECT id FROM grades WHERE name = 'Grade 12'").get().id;

const coordId = insertUser.run("Mrs. Petunia Wobblebottom", "coordinator2@argus.school", hash("coord1234"), "COORDINATOR", grade2, null).lastInsertRowid;
insertUser.run("Mr. Vikram Rao", "coordinator12@argus.school", hash("coord1234"), "COORDINATOR", grade12, null);

const teacherPE = insertUser.run("Mr. Baxter Higglesworth", "pe@argus.school", hash("teach1234"), "TEACHER", grade2, "Physical Education").lastInsertRowid;
const teacherClass2 = insertUser.run("Mrs. Petunia Wobblebottom", "class2@argus.school", hash("teach1234"), "TEACHER", grade2, "Class Teacher").lastInsertRowid;
insertUser.run("Ms. Anita Desai", "math12@argus.school", hash("teach1234"), "TEACHER", grade12, "Math");
insertUser.run("Dr. Ravi Menon", "physics12@argus.school", hash("teach1234"), "TEACHER", grade12, "Physics");
insertUser.run("Ms. Fatima Khan", "chem12@argus.school", hash("teach1234"), "TEACHER", grade12, "Chemistry");
insertUser.run("Mr. Suresh Nair", "bio12@argus.school", hash("teach1234"), "TEACHER", grade12, "Biology");

// ---- Parent + fully described child (this is the demo parent login) ----
const parentId = insertUser.run("Rajesh Wigglesworth", "parent@argus.school", hash("parent1234"), "PARENT", null, null).lastInsertRowid;

const bobId = db.prepare(`
  INSERT INTO students
    (name, grade_id, parent_user_id, admission_number, admission_date,
     parent_full_name, contact_phone, contact_email, home_address,
     transport_method, bus_route, level)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "Bob Wigglesworth", grade2, parentId,
  "PHX-2023-0482", "2023-06-05",
  "Rajesh Wigglesworth", "+91 98765 43210", "parent@argus.school",
  "Villa 12, Mantri Euphoria, Manchirevula, Hyderabad 500089",
  "School Bus", "Route 47A", "Level 2 Reader"
).lastInsertRowid;

// A couple more Grade 2 students so attendance/marks screens look real
const arav = db.prepare(`
  INSERT INTO students (name, grade_id, admission_number, admission_date, transport_method)
  VALUES (?, ?, ?, ?, ?)
`).run("Arav Sharma", grade2, "PHX-2023-0511", "2023-06-05", "Own Transport").lastInsertRowid;
const meera = db.prepare(`
  INSERT INTO students (name, grade_id, admission_number, admission_date, transport_method, bus_route)
  VALUES (?, ?, ?, ?, ?, ?)
`).run("Meera Iyer", grade2, "PHX-2023-0534", "2023-06-06", "School Bus", "Route 22B").lastInsertRowid;

// ---- Marks for Bob (approved + uploaded), so the parent app shows results ----
const setPerm = db.prepare(`
  INSERT INTO marks_permissions (grade_id, test_name, subject, allowed, set_by)
  VALUES (?, ?, ?, 1, ?)
`);
const addScore = db.prepare(`
  INSERT INTO test_scores (student_id, subject, test_name, score, total, uploaded_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const g2subjects = [["English", 41, 50], ["Math", 46, 50], ["EVS", 38, 50], ["Art", 49, 50]];
for (const [subject, score, total] of g2subjects) {
  setPerm.run(grade2, "Term Test 1", subject, teacherClass2);
  addScore.run(bobId, subject, "Term Test 1", score, total, teacherClass2);
}
const g2periodic = [["English", 17, 20], ["Math", 19, 20], ["EVS", 15, 20], ["Art", 20, 20]];
for (const [subject, score, total] of g2periodic) {
  setPerm.run(grade2, "Periodic Test 1", subject, teacherClass2);
  addScore.run(bobId, subject, "Periodic Test 1", score, total, teacherClass2);
}

// ---- Attendance history for Bob ----
const addAtt = db.prepare("INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, ?, ?)");
const today = new Date();
for (let i = 0; i < 20; i++) {
  const d = new Date(today);
  d.setDate(d.getDate() - i);
  if (d.getDay() === 0 || d.getDay() === 6) continue; // skip weekends
  const status = i === 3 ? "ABSENT" : i === 7 ? "LATE" : "PRESENT";
  addAtt.run(bobId, d.toISOString().slice(0, 10), status, teacherClass2);
}

// ---- Notices ----
// Intentionally left empty. Post real notices from the admin portal
// (Notices tab) once the app is deployed — nothing here shows up by
// default for parents anymore.

// ---- Syllabus portion (Grade 2, editable from the admin portal) ----
const addChapter = db.prepare(`
  INSERT INTO syllabus_chapters (grade_id, subject, test_name, chapter_name, sort_order, created_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
[
  ["Math", "PT1", ["Numbers up to 1000", "Addition and Subtraction", "Shapes and Patterns"]],
  ["Math", "PT2", ["Multiplication", "Division Basics", "Measurement"]],
  ["EVS", "PT1", ["My Family", "Plants Around Us"]],
  ["EVS", "PT2", ["Animals and Their Homes", "Water and Its Uses"]],
].forEach(([subject, test, chapters]) => {
  chapters.forEach((ch, i) => addChapter.run(grade2, subject, test, ch, i, coordId));
});

// ---- Submission requirements (Grade 2 example, set up by the coordinator) ----
const addRequirement = db.prepare(`
  INSERT INTO submission_requirements (grade_id, title, type, due_date, created_by)
  VALUES (?, ?, ?, ?, ?)
`);
addRequirement.run(grade2, "My Family Tree Poster", "Project", null, coordId);
addRequirement.run(grade2, "Plant a Seed - Observation Diary", "Assignment", null, coordId);

// ---- Messages: two teacher threads with Bob's parent ----
function makeThread(teacherId, firstMessage) {
  const tid = db.prepare(
    "INSERT INTO message_threads (teacher_id, parent_id, student_id) VALUES (?, ?, ?)"
  ).run(teacherId, parentId, bobId).lastInsertRowid;
  db.prepare("INSERT INTO messages (thread_id, sender_id, body) VALUES (?, ?, ?)").run(tid, teacherId, firstMessage);
  return tid;
}
makeThread(teacherClass2, "Bob blew up the lab today. Everyone is fine and the fire alarm did not even go off, but we will not be doing the baking soda volcano again this year.");
makeThread(teacherPE, "Bob got abducted by a pigeon at recess today. He was carried about four feet before landing safely on the mats and asking if we could do it again.");

// ---- Almanac (IT-owned) ----
const addAlmanac = db.prepare(`
  INSERT INTO almanac_events (date, title, category, note, created_by) VALUES (?, ?, ?, ?, ?)
`);
[
  ["2026-08-15", "Independence Day", "HOLIDAY", "School closed"],
  ["2026-09-14", "Term Test 1 begins", "PT3", "Grades 1 to 12"],
  ["2026-10-02", "Gandhi Jayanti", "HOLIDAY", "School closed"],
  ["2026-10-20", "Dussehra break begins", "HOLIDAY", "School resumes October 27"],
].forEach(([date, title, cat, note]) => addAlmanac.run(date, title, cat, note, itId));

console.log("\nDone. Sign in with any of these:\n");
console.log("  SUPER_ADMIN   superadmin@argus.school     super1234");
console.log("  ADMIN         principal@argus.school      admin1234");
console.log("  IT_ADMIN      it@argus.school             itadmin1234");
console.log("  COORDINATOR   coordinator2@argus.school   coord1234   (Grade 2)");
console.log("  TEACHER       class2@argus.school         teach1234   (Grade 2)");
console.log("  PARENT        parent@argus.school         parent1234  (Bob, Grade 2)");
console.log("\nChange these passwords before going live.\n");
