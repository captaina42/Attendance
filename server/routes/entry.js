// The single entry point of the installed app: one sign-in, two destinations.
// Staff and students use the same form; the server decides the role and the redirect.
const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const {
  issueStaffSession,
  issueStudentSession,
  clearStaffSession,
  clearStudentSession,
  currentRole,
  sameOrigin,
} = require("../middleware/auth");

const router = express.Router();

const entryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again in a few minutes." },
});

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const STUDENT_HOME = "/student/";
const STAFF_HOME = "/dashboard.html";

// Used by the entry page to skip the form for an existing session.
router.get("/session", (req, res) => {
  const role = currentRole(req);
  res.set("Cache-Control", "no-store");
  res.json({
    authenticated: Boolean(role),
    role: role || null,
    redirect: role === "staff" ? STAFF_HOME : role === "student" ? STUDENT_HOME : null,
  });
});

router.post("/login", sameOrigin, entryLimiter, (req, res) => {
  const identifier = clean(req.body?.identifier);
  const password = String(req.body?.password || "");
  if (!identifier || !password)
    return res.status(400).json({ error: "Enter your email or student number and password." });

  // Staff are matched by email; students by student number or email.
  const staff = db.prepare("SELECT * FROM staff WHERE email = ? COLLATE NOCASE").get(identifier);
  if (staff && bcrypt.compareSync(password, staff.password_hash)) {
    clearStudentSession(res); // never hold both roles at once
    issueStaffSession(res, staff);
    return res.json({ role: "staff", redirect: STAFF_HOME, name: staff.name });
  }

  const student = db
    .prepare("SELECT * FROM students WHERE student_number = ? COLLATE NOCASE OR email = ? COLLATE NOCASE")
    .get(identifier, identifier);
  if (student && bcrypt.compareSync(password, student.password_hash)) {
    clearStaffSession(res);
    issueStudentSession(res, student);
    return res.json({ role: "student", redirect: STUDENT_HOME, name: student.full_name });
  }

  res.status(401).json({ error: "Those details do not match any account." });
});

router.post("/logout", sameOrigin, (req, res) => {
  clearStaffSession(res);
  clearStudentSession(res);
  res.json({ ok: true });
});

module.exports = router;
