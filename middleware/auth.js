// middleware/auth.js
// JWT verification plus the role rules from the hierarchy notes.
//
//   SUPER_ADMIN  (us / IT department)  -> can do anything, manages every role
//   ADMIN        (Principal / Head)    -> oversees coordinators + teachers, all grades
//   COORDINATOR  (sub admin)           -> owns ONE grade, approves marks uploads
//   IT_ADMIN     (IT department staff) -> owns the almanac
//   TEACHER                            -> notices, attendance, marks (when approved), messages
//   PARENT                             -> read-only, own child only

const jwt = require("jsonwebtoken");
const db = require("../db/db");

// SECURITY FIX #4: JWT_SECRET is now required. Fail on startup if missing.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET environment variable is required.\n" +
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
    "Then set it in your .env or Render environment variables."
  );
}

// Higher number = more authority. Used for "can this user manage that user".
const ROLE_RANK = {
  SUPER_ADMIN: 100,
  ADMIN: 80,
  IT_ADMIN: 60,
  COORDINATOR: 50,
  TEACHER: 30,
  PARENT: 10,
};

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, grade_id: user.grade_id },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

// Attaches req.user. Rejects missing/expired/deactivated accounts.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db
      .prepare("SELECT * FROM users WHERE id = ? AND is_active = 1")
      .get(payload.id);
    if (!user) return res.status(401).json({ error: "Account not found or deactivated" });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// requireRole('SUPER_ADMIN', 'ADMIN')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Your role cannot perform this action" });
    }
    next();
  };
}

// A user may only create/delete accounts strictly below their own rank.
// This is what stops a COORDINATOR from creating an ADMIN, etc.
function canManageRole(actorRole, targetRole) {
  // Special case: only a SUPER_ADMIN can create another SUPER_ADMIN. Every
  // other role can only create roles strictly below their own rank.
  if (actorRole === "SUPER_ADMIN" && targetRole === "SUPER_ADMIN") return true;
  return ROLE_RANK[actorRole] > ROLE_RANK[targetRole];
}

// COORDINATOR and TEACHER are scoped to their own grade. ADMIN and
// SUPER_ADMIN see every grade. Returns true if access is allowed.
function canAccessGrade(user, gradeId) {
  if (user.role === "SUPER_ADMIN" || user.role === "ADMIN" || user.role === "IT_ADMIN") return true;
  if (user.role === "COORDINATOR" || user.role === "TEACHER") {
    return Number(user.grade_id) === Number(gradeId);
  }
  return false;
}

// A section belongs to one grade. Coordinator of that grade, that section's
// own class teacher, and any admin-level role can access it. Other teachers
// (not assigned to this section) cannot.
function canAccessSection(user, section) {
  if (user.role === "SUPER_ADMIN" || user.role === "ADMIN" || user.role === "IT_ADMIN") return true;
  if (user.role === "COORDINATOR") return Number(user.grade_id) === Number(section.grade_id);
  if (user.role === "TEACHER") return Number(user.id) === Number(section.class_teacher_id);
  return false;
}

module.exports = {
  JWT_SECRET,
  ROLE_RANK,
  signToken,
  requireAuth,
  requireRole,
  canManageRole,
  canAccessGrade,
  canAccessSection,
};
