// JWT cookie authentication for both audiences.
// Staff ride on the original Attendance Pro cookie (ap_token); students on ap_student.
const jwt = require("jsonwebtoken");
const { JWT_SECRET, TOKEN_TTL_SECONDS, COOKIE_SECURE } = require("../config");
const { db } = require("../db");

const STAFF_COOKIE = "ap_token";
const STUDENT_COOKIE = "ap_student";

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: "/",
  };
}

function issueStaffSession(res, staff) {
  const token = jwt.sign({ sub: String(staff.id), role: "staff" }, JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
  res.cookie(STAFF_COOKIE, token, cookieOptions());
}

function issueStudentSession(res, student) {
  const token = jwt.sign({ sub: String(student.id), role: "student" }, JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
  res.cookie(STUDENT_COOKIE, token, cookieOptions());
}

function clearStaffSession(res) {
  res.clearCookie(STAFF_COOKIE, { path: "/" });
}

function clearStudentSession(res) {
  res.clearCookie(STUDENT_COOKIE, { path: "/" });
}

function tokenFrom(req, cookieName) {
  const fromCookie = req.cookies ? req.cookies[cookieName] : null;
  if (fromCookie) return fromCookie;
  const header = req.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function decode(req, cookieName, role) {
  const token = tokenFrom(req, cookieName);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== role) return null;
    return payload;
  } catch {
    return null;
  }
}

// Which of the two audiences this request is signed in as (if any).
function currentRole(req) {
  if (decode(req, STAFF_COOKIE, "staff")) return "staff";
  if (decode(req, STUDENT_COOKIE, "student")) return "student";
  return null;
}

function requireStaff(req, res, next) {
  const payload = decode(req, STAFF_COOKIE, "staff");
  if (!payload) return res.status(401).json({ error: "Staff sign-in required." });
  const staff = db
    .prepare("SELECT id, name, email FROM staff WHERE id = ?")
    .get(Number(payload.sub));
  if (!staff) return res.status(401).json({ error: "Staff account no longer exists." });
  req.staff = staff;
  next();
}

function requireStudent(req, res, next) {
  const payload = decode(req, STUDENT_COOKIE, "student");
  if (!payload) return res.status(401).json({ error: "Student sign-in required." });
  const student = db
    .prepare(
      "SELECT id, full_name, student_number, email, department, level FROM students WHERE id = ?",
    )
    .get(Number(payload.sub));
  if (!student) return res.status(401).json({ error: "Student account no longer exists." });
  req.student = student;
  next();
}

// State-changing requests must come from our own pages (CSRF defence on top of SameSite).
function sameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next(); // non-browser client (tests, curl)
  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch {
    /* fall through */
  }
  return res.status(403).json({ error: "Cross-origin request blocked." });
}

module.exports = {
  STAFF_COOKIE,
  STUDENT_COOKIE,
  issueStaffSession,
  issueStudentSession,
  clearStaffSession,
  clearStudentSession,
  requireStaff,
  requireStudent,
  currentRole,
  sameOrigin,
};
