# Argus Backend and Admin Portal

Backend for the Argus school app. Handles accounts, role permissions, notices, teacher-parent messaging, attendance, test scores and the almanac.

## Role hierarchy

```
SUPER_ADMIN   (us / IT department)   creates every other role, full access
   |
ADMIN         (Principal / Head)     oversees coordinators and teachers, all grades
   |
IT_ADMIN      (IT department)        owns the almanac
COORDINATOR   (sub admin)            owns ONE grade, approves marks uploads
   |
TEACHER                              notices, attendance, marks (once approved), messages
   |
PARENT                               read-only, own child only
```

**The key rule:** a teacher cannot upload marks until the coordinator for that grade has switched on permission for that specific grade + test + subject. The API rejects the upload outright if the toggle is off.

## What each role can do

| Action | SUPER_ADMIN | ADMIN | IT_ADMIN | COORDINATOR | TEACHER | PARENT |
|---|---|---|---|---|---|---|
| Create ADMIN / IT_ADMIN | yes | no | no | no | no | no |
| Create COORDINATOR | yes | yes | no | no | no | no |
| Create TEACHER / PARENT | yes | yes | no | yes (own grade) | no | no |
| Approve marks uploads | yes | yes | no | yes (own grade) | no | no |
| Upload marks | no | no | no | no | yes (when approved) | no |
| Mark attendance | yes | yes | no | yes | yes | no |
| Manage almanac | yes | no | yes | no | no | no |
| Post school-wide notice | yes | yes | yes | no | no | no |
| Post grade notice | yes | yes | yes | yes | yes | no |
| Message parents | no | no | no | no | yes | yes (reply) |
| View child marks / attendance | yes | yes | no | yes | yes | own child only |

## Running it locally

```bash
npm install
cp .env.example .env      # then edit JWT_SECRET
npm run seed              # creates demo school + accounts
npm start
```

- Admin portal: http://localhost:3000/admin.html
- Parent app: http://localhost:3000/index.html

### Seeded accounts

| Role | Email | Password |
|---|---|---|
| SUPER_ADMIN | superadmin@argus.school | super1234 |
| ADMIN | principal@argus.school | admin1234 |
| IT_ADMIN | it@argus.school | itadmin1234 |
| COORDINATOR (Grade 12) | coordinator12@argus.school | coord1234 |
| TEACHER (Physics, Grade 12) | physics12@argus.school | teach1234 |
| PARENT | parent@argus.school | parent1234 |

Change all of these before going live.

## API reference

All endpoints except login need `Authorization: Bearer <token>`.

### Auth
- `POST /api/auth/login` `{email, password}` returns token
- `GET /api/auth/me`
- `POST /api/auth/change-password` `{current_password, new_password}`

### Users
- `GET /api/users?role=&grade_id=`
- `POST /api/users` `{name, email, role, grade_id?, subject?}` returns a temporary password
- `PATCH /api/users/:id`
- `DELETE /api/users/:id` (soft delete; `?hard=true` for SUPER_ADMIN)
- `POST /api/users/:id/reset-password`
- `GET /api/users/meta/grades`

### Students
- `GET /api/students?grade_id=` (parents get their own children automatically)
- `POST /api/students` `{name, grade_id, parent_user_id?}`
- `PATCH /api/students/:id`, `DELETE /api/students/:id`

### Scores
- `GET /api/scores/permissions?grade_id=`
- `PUT /api/scores/permissions` `{grade_id, test_name, subject, allowed}` — the coordinator toggle
- `GET /api/scores/can-upload?test_name=` — teacher checks before showing the form
- `POST /api/scores` `{test_name, entries:[{student_id, score, total}]}`
- `GET /api/scores/student/:id` — grouped by test, ready for the parent app

### Attendance
- `POST /api/attendance` `{date, entries:[{student_id, status}]}` (PRESENT/ABSENT/LATE/EXCUSED)
- `GET /api/attendance?grade_id=&date=`
- `GET /api/attendance/student/:id` — summary plus recent history

### Notices
- `GET /api/notices?category=` — parents auto-filtered to their child's grade plus school-wide
- `POST /api/notices` `{title, body, category, grade_id?}` (null grade = school-wide, admins only)
- `DELETE /api/notices/:id`

### Messages
- `GET /api/messages/threads`
- `GET /api/messages/threads/:id`
- `POST /api/messages` `{thread_id, body}` or `{teacher_id, parent_id, student_id, body}`

### Almanac (IT_ADMIN only for writes)
- `GET /api/almanac?year=&month=`
- `POST /api/almanac` `{date, title, category, note}` (PT1/PT2/PT3/HOLIDAY/EVENT)
- `POST /api/almanac/bulk` `{events:[...]}`
- `PATCH /api/almanac/:id`, `DELETE /api/almanac/:id`

## Notes

- Database is SQLite in a single file (`db/argus.sqlite`), no separate DB server needed. Every route goes through `db/db.js`, so moving to Postgres later means changing that one file.
- Passwords are hashed with bcrypt. Tokens are JWTs valid for 12 hours.
- Deleting a user deactivates by default so their past notices and uploaded marks keep a valid author.

## Update: parent app is now data-driven

`index.html` (the parent app) is wired to this API. On load it shows a login
overlay (pre-filled with the demo parent). After sign-in it pulls the child's
profile, notices, teacher messages, marks and almanac live from the backend.
When a teacher uploads marks (after coordinator approval), the parent sees them
on next load. The bus map stays a simulation for now.

### Student profiles and parent accounts

Adding a student and its parent login is one step. In the admin portal go to
**People, Students and Parents, Add a student** and fill in the child plus the
parent's email. A PARENT account is created automatically and its temporary
password is shown once. Tap any student row to open a full detail page
(admission number and date, parent name and contact, home address, transport
method and bus route).

### Notice attachments

When posting a notice, staff can attach a PDF or image (under 3 MB). It is
stored with the notice and parents get a download link on the notice card.
