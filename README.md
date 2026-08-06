# 🏫 Argus — School Management System

**Argus** is a full-stack school management platform covering everything from student records and attendance to parent communication and academic performance tracking. It runs as a single Node.js/Express backend serving two web frontends (Admin/Staff portal + Parent portal) backed by a SQL database.

---

## 📌 Table of Contents

1. [System Overview](#-system-overview)
2. [Architecture](#-architecture)
3. [Roles & Permissions](#-roles--permissions)
4. [Feature Breakdown — Admin/Staff Side](#-feature-breakdown--adminstaff-side)
5. [Feature Breakdown — Parent Side](#-feature-breakdown--parent-side)
6. [API Reference](#-api-reference)
7. [Database Schema](#-database-schema-overview)
8. [Security](#-security)
9. [Setup & Deployment](#-setup--deployment)
10. [Environment Variables](#-environment-variables)

---

## 🧭 System Overview

| Component | File(s) | Purpose |
|---|---|---|
| **Backend server** | `server.js` | Express app, routing, CORS, static file serving |
| **Database layer** | `db/db.js`, `db/seed.js` | SQL abstraction + seed data |
| **Auth middleware** | `middleware/auth.js` | JWT verification, role checks, grade/section scoping |
| **API routes** | `routes/*.js` | 12 route modules (see below) |
| **Admin/Staff portal** | `admin.html` | Single-page app for staff (all roles except Parent) |
| **Parent portal** | `index.html` | Single-page app for parents |
| **Password reset page** | `reset-password.html` | Standalone reset flow |
| **Email utility** | `utils/mailer.js` | Transactional emails (password reset, etc.) |

The whole system is deployed as **one Render web service** — Express serves both the API (`/api/*`) and the two frontend HTML apps directly, so there's no separate frontend hosting needed.

---

## 🏗️ Architecture

```
                         ┌─────────────────────────┐
                         │        Render.com        │
                         │   (single web service)   │
                         └────────────┬─────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │            server.js (Express)      │
                    └─────────────────┬─────────────────┘
                                      │
       ┌──────────────┬──────────────┼──────────────┬──────────────┐
       │              │              │               │              │
  admin.html     index.html   reset-password.html   /api/*      static assets
 (Staff SPA)    (Parent SPA)    (public page)    (12 route modules)
                                                        │
                                                  ┌──────┴───────┐
                                                  │   db/db.js    │
                                                  │ (SQL wrapper) │
                                                  └───────────────┘
```

**Request flow example (parent viewing attendance):**
1. Parent logs in via `index.html` → `POST /api/auth/login` → receives JWT
2. JWT stored client-side, sent as `Authorization: Bearer <token>` on every request
3. `requireAuth` middleware validates token + loads `req.user`
4. `GET /api/attendance/student/:id` checks `req.user` is the linked parent
5. Data returned, rendered client-side

---

## 👥 Roles & Permissions

Argus uses a **6-tier role hierarchy** with grade/section scoping:

| Role | Rank | Scope | Typical User |
|---|---|---|---|
| `SUPER_ADMIN` | 100 | Everything | IT department / platform owner |
| `ADMIN` | 80 | Everything | Principal / Head of school |
| `IT_ADMIN` | 60 | Everything + owns almanac/sections | IT department staff |
| `COORDINATOR` | 50 | One grade, all its sections | Grade-level sub-admin |
| `TEACHER` | 30 | Their own assigned section only | Classroom teacher |
| `PARENT` | 10 | Their own child(ren) only | Parent/guardian |

**Scoping rules (enforced in `middleware/auth.js`):**
- `canAccessGrade(user, gradeId)` — SUPER_ADMIN/ADMIN/IT_ADMIN see all grades; COORDINATOR/TEACHER locked to `user.grade_id`
- `canAccessSection(user, section)` — TEACHER locked to sections where they are `class_teacher_id`
- `canManageRole(actorRole, targetRole)` — a role can only create accounts strictly below its own rank (prevents privilege escalation)

---

## 🖥️ Feature Breakdown — Admin/Staff Side

### 1. People Management
- **Students**: create, view, edit full profile (admission info, parent details, transport, contact), delete
- **Staff accounts**: create teachers/coordinators/admins, assign to grade, reset passwords
- Parent login accounts are **auto-created** when a student is registered with a `contact_email` — a temporary password is generated and returned once

### 2. Sections
- IT_ADMIN/SUPER_ADMIN create sections per grade (e.g. "Grade 5 - A") and assign a class teacher
- **Teacher search-as-you-type**: type a name into the class-teacher field, autocomplete suggests matches instantly (falls back to manual user-ID entry if the role can't list users)
- Section list shows student count, teacher name; clicking a section opens its **Class Group** board

### 3. Grade & Section Promotion *(new)*
- **Individual move**: open any student's profile → pick new grade + section → Save
  - Teachers: can move students only within/into their own section (no grade change)
  - Coordinator/IT_ADMIN/Admin/Super Admin: full cross-grade, cross-section control
- **Bulk promotion**: promote an entire grade to the next grade in one action, with optional section-to-section mapping (e.g. all of "Grade 1-A" → "Grade 2-A")
- **Preview mode**: see exactly which students will land in which new section before committing

### 4. Attendance
- Teacher opens their section → auto-loaded roster, everyone defaults to `ABSENT`
- Tap to flip status: `PRESENT` / `ABSENT` / `LATE` / `EXCUSED`
- Save marks the whole day in one request (upsert — safe to re-save/edit same day)
- Coordinators/Admins can view attendance across any date/grade

### 5. Class Group (per-section board)
- One-way announcement board scoped to a single section
- Posted by: that section's class teacher, the grade's coordinator, or any admin
- Visible to: that section's parents + teacher (coordinator sees all sections in her grade)
- Supports file attachments (base64, size-validated)

### 6. Notice Board (school/grade-wide)
- Teachers and above can post; grade-specific or school-wide (school-wide requires Admin+)
- Category tagging, file attachments (3 MB limit, strict MIME validation)
- Parents see notices scoped to their child's grade + all school-wide notices

### 7. Messages (Teacher ↔ Parent)
- One-way by default (teacher-initiated); teacher can flip a toggle to enable two-way replies
- Threaded conversations per student/parent pair

### 8. Academic Almanac
- IT_ADMIN/SUPER_ADMIN maintain a school calendar (events, holidays, exam dates)
- Supports single and bulk entry creation

### 9. Syllabus Tracker
- Teachers log syllabus progress per subject/grade
- Coordinators/Admins can review completion across a grade

### 10. Scores & Submissions
- Teachers upload test scores (gated by a permissions toggle set by Coordinator/Admin)
- Submission requirements (assignments/projects) tracked per student with status
- Performance dashboard: average scores + submission compliance per student, drillable to detail view

---

## 👨‍👩‍👧 Feature Breakdown — Parent Side

| Feature | Description | Status |
|---|---|---|
| **Home dashboard** | Latest notice preview, message center preview, bus tracker card | ✅ |
| **Attendance** | View own child's attendance history + percentage summary | ✅ |
| **Notices** | Filterable by category, scoped to child's grade + school-wide | ✅ |
| **Class Group** *(new)* | Read section-specific announcements from child's class teacher, under a "Class group" sub-tab inside Notices | ✅ |
| **Messages** | Threaded chat with child's teachers, reply if two-way is enabled | ✅ |
| **Homework / Curriculum** | Syllabus progress, submission requirements | ✅ |
| **Scores** | Test scores by subject, filterable | ✅ |
| **Bus tracker** | Transport method + route info | ✅ |
| **Password reset** | Self-service via `reset-password.html` | ✅ |

All parent views are **automatically scoped** — a parent only ever sees data belonging to their own linked child(ren) (enforced server-side, not just hidden in the UI).

---

## 📡 API Reference

Base path: `/api`. All routes except `/auth/login`, `/auth/forgot-password`, `/auth/reset-password` require `Authorization: Bearer <JWT>`.

### Auth (`/api/auth`)
| Method | Path | Access |
|---|---|---|
| POST | `/login` | Public (rate-limited) |
| GET | `/me` | Any authenticated user |
| POST | `/change-password` | Any authenticated user |
| POST | `/forgot-password` | Public (rate-limited) |
| POST | `/reset-password` | Public (token-based) |

### Students (`/api/students`)
| Method | Path | Access |
|---|---|---|
| GET | `/` | Staff (grade-scoped) / Parent (own children) |
| GET | `/:id` | Staff (grade-scoped) / Parent (own child) |
| POST | `/` | SUPER_ADMIN, ADMIN, COORDINATOR |
| PATCH | `/:id` | SUPER_ADMIN, ADMIN, COORDINATOR |
| DELETE | `/:id` | SUPER_ADMIN, ADMIN |

### Promotion (`/api/promotion`) — *new*
| Method | Path | Access |
|---|---|---|
| POST | `/individual` | SUPER_ADMIN, ADMIN, IT_ADMIN, COORDINATOR, TEACHER (section-only) |
| POST | `/bulk` | SUPER_ADMIN, ADMIN, IT_ADMIN, COORDINATOR |
| GET | `/preview-bulk` | SUPER_ADMIN, ADMIN, IT_ADMIN, COORDINATOR |

### Sections (`/api/sections`)
| Method | Path | Access |
|---|---|---|
| GET | `/` | Any authenticated (grade-scoped) |
| GET | `/:id` | Any authenticated (section-scoped) |
| POST | `/` | IT_ADMIN, SUPER_ADMIN |
| PATCH | `/:id` | IT_ADMIN, SUPER_ADMIN |
| DELETE | `/:id` | IT_ADMIN, SUPER_ADMIN |

### Attendance (`/api/attendance`)
| Method | Path | Access |
|---|---|---|
| POST | `/` | TEACHER, COORDINATOR, ADMIN, SUPER_ADMIN |
| GET | `/` | TEACHER, COORDINATOR, ADMIN, SUPER_ADMIN |
| GET | `/section/:sectionId` | TEACHER, COORDINATOR, ADMIN, SUPER_ADMIN (section-scoped) |
| GET | `/student/:studentId` | Staff (grade-scoped) / Parent (own child) |

### Class Group (`/api/classgroup`)
| Method | Path | Access |
|---|---|---|
| GET | `/:sectionId` | Section's teacher, grade coordinator, admin, or parent with child in section |
| POST | `/:sectionId` | Section's teacher, grade coordinator, or admin |
| DELETE | `/post/:postId` | Same as posting |

### Notices (`/api/notices`)
| Method | Path | Access |
|---|---|---|
| GET | `/` | Any authenticated (scoped) |
| POST | `/` | TEACHER, COORDINATOR, ADMIN, SUPER_ADMIN, IT_ADMIN |
| GET | `/:id/attachment` | Any authenticated (scoped) |
| DELETE | `/:id` | Author or ADMIN/SUPER_ADMIN/COORDINATOR |

### Messages (`/api/messages`)
| Method | Path | Access |
|---|---|---|
| GET | `/threads` | Any authenticated (own threads) |
| GET | `/threads/:id` | Thread participant |
| PATCH | `/threads/:id/two-way` | Teacher (toggle) |
| POST | `/` | Any authenticated (own threads) |

### Users / Staff (`/api/users`)
| Method | Path | Access |
|---|---|---|
| GET | `/` | SUPER_ADMIN, ADMIN, COORDINATOR |
| POST | `/` | SUPER_ADMIN, ADMIN, COORDINATOR |
| PATCH | `/:id` | SUPER_ADMIN, ADMIN, COORDINATOR |
| DELETE | `/:id` | SUPER_ADMIN, ADMIN, COORDINATOR |
| POST | `/:id/reset-password` | SUPER_ADMIN, ADMIN, COORDINATOR |
| GET | `/meta/grades` | Any authenticated |

### Almanac (`/api/almanac`)
| Method | Path | Access |
|---|---|---|
| GET | `/` | Any authenticated |
| POST | `/` | IT_ADMIN, SUPER_ADMIN |
| POST | `/bulk` | IT_ADMIN, SUPER_ADMIN |
| PATCH | `/:id` | IT_ADMIN, SUPER_ADMIN |
| DELETE | `/:id` | IT_ADMIN, SUPER_ADMIN |

### Syllabus (`/api/syllabus`)
| Method | Path | Access |
|---|---|---|
| GET | `/` | Any authenticated (scoped) |
| POST | `/` | TEACHER, COORDINATOR, ADMIN, SUPER_ADMIN |
| PATCH | `/:id` | TEACHER, COORDINATOR, ADMIN, SUPER_ADMIN |
| DELETE | `/:id` | TEACHER, COORDINATOR, ADMIN, SUPER_ADMIN |

### Scores (`/api/scores`)
| Method | Path | Access |
|---|---|---|
| GET | `/permissions` | Any authenticated |
| PUT | `/permissions` | COORDINATOR, ADMIN, SUPER_ADMIN |
| GET | `/can-upload` | TEACHER |
| POST | `/` | TEACHER |
| GET | `/student/:studentId` | Staff (scoped) / Parent (own child) |

### Submissions (`/api/submissions`)
| Method | Path | Access |
|---|---|---|
| GET | `/requirements` | Staff roles |
| POST | `/requirements` | Setup roles (Coordinator+) |
| DELETE | `/requirements/:id` | Setup roles |
| GET | `/requirements/:id/status` | Staff roles |
| POST | `/requirements/:id/status` | Staff roles |
| GET | `/performance/grade/:gradeId` | Setup roles |
| GET | `/performance/student/:studentId` | Setup roles |

### Health
| Method | Path | Access |
|---|---|---|
| GET | `/api/health` | Public |

---

## 🗄️ Database Schema Overview

Core tables (see `db/db.js` / `db/seed.js` for full DDL):

- **`users`** — staff + parent accounts (role, grade_id, password_hash)
- **`students`** — student records (grade_id, section_id, parent_user_id, profile fields)
- **`grades`** — grade/class levels
- **`sections`** — sections within a grade (class_teacher_id)
- **`attendance`** — per-student, per-date status
- **`notices`** — school/grade-wide announcements
- **`class_group_posts`** — section-scoped announcements
- **`messages` / `message_threads`** — teacher↔parent conversations
- **`scores`** — test scores per student/subject
- **`submission_requirements` / `submission_status`** — assignment tracking
- **`syllabus`** — subject progress per grade
- **`almanac`** — school calendar entries

---

## 🔒 Security

Argus has been through a security hardening pass. Key protections in place:

| # | Fix | Where |
|---|---|---|
| 1 | Only whitelisted HTML files served; `db/`, `routes/`, `middleware/`, `utils/` blocked from static serving | `server.js` |
| 2 | CORS allowlist (not open to all origins) | `server.js` via `ALLOWED_ORIGINS` env var |
| 3 | JWT auth required on all protected routes | `middleware/auth.js` |
| 4 | `JWT_SECRET` is mandatory — server refuses to start without it | `middleware/auth.js` |
| 5 | Strict file upload validation (3 MB cap, MIME type regex) | `notices.js`, `classgroup.js` |
| 6 | Role-rank based account creation (can't create a role above your own) | `middleware/auth.js` |
| 7 | Grade/section scoping enforced server-side on every query, not just UI-hidden | All route modules |
| 8 | HTTPS redirect in production | `server.js` |
| 9 | HSTS header | `server.js` |
| 10 | Rate limiting on login + forgot-password | `routes/auth.js` |
| 11 | bcrypt password hashing | `routes/auth.js`, `routes/users.js`, `routes/students.js` |

---

## ⚙️ Setup & Deployment

### Local development
```bash
npm install
cp .env.example .env   # fill in values, see below
node server.js
```
Visit `http://localhost:3000/admin.html` (staff) or `http://localhost:3000/index.html` (parent).

### Production (Render)
This repo includes `render.yaml` for one-click Render deployment. After deploying:
1. Go to your Render service → **Environment**
2. Add all variables listed below
3. Trigger a deploy

---

## 🔧 Environment Variables

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `JWT_SECRET` | ✅ | `<64-char hex string>` | Signs auth tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_ORIGINS` | ✅ | `https://argus-backend-wcme.onrender.com` | Comma-separated list of origins allowed by CORS |
| `PORT` | ❌ | `3000` | Server port (Render sets this automatically) |
| `NODE_ENV` | ❌ | `production` | Enables HTTPS redirect when set to `production` |
| Mailer vars (SMTP host/user/pass) | ✅ for password reset | — | See `utils/mailer.js` for exact variable names used |

---

## 🆕 Recent Additions (this development cycle)

1. **CORS allowlist configuration** — documented `ALLOWED_ORIGINS` setup
2. **Promotion system** — `routes/promotion.js`: individual + bulk grade/section promotion, teacher-scoped moves
3. **Admin UI: grade & section change** — dropdown-based mover on student profile
4. **Admin UI: teacher search-as-you-type** — autocomplete for class teacher assignment
5. **Parent UI: Class Group view** — new sub-tab under Notices, reads section-scoped posts

---

*Argus — built for Phoenix Greens School of Learning.*
