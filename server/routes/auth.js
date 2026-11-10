// Staff accounts (lecturer dashboard).
const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { db } = require("../db");
const {
  issueStaffSession,
  clearStaffSession,
  requireStaff,
  sameOrigin,
} = require("../middleware/auth");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

const emailLooksValid = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const publicStaff = (s) => ({ id: s.id, name: s.name, email: s.email });

router.post("/register", sameOrigin, authLimiter, (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (name.length < 2) return res.status(400).json({ error: "Enter your full name." });
  if (!emailLooksValid(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (db.prepare("SELECT 1 FROM staff WHERE email = ?").get(email))
    return res.status(409).json({ error: "An account with that email already exists." });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO staff (name, email, password_hash, created_at) VALUES (?,?,?,?)")
    .run(name, email, hash, Date.now());
  const staff = db.prepare("SELECT * FROM staff WHERE id = ?").get(Number(info.lastInsertRowid));
  issueStaffSession(res, staff);
  res.status(201).json({ user: publicStaff(staff), staff: publicStaff(staff) });
});

router.post("/login", sameOrigin, authLimiter, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const staff = email ? db.prepare("SELECT * FROM staff WHERE email = ?").get(email) : null;
  if (!staff || !bcrypt.compareSync(password, staff.password_hash))
    return res.status(401).json({ error: "Invalid email or password." });
  issueStaffSession(res, staff);
  res.json({ user: publicStaff(staff), staff: publicStaff(staff) });
});

router.post("/logout", sameOrigin, (req, res) => {
  clearStaffSession(res);
  res.json({ ok: true });
});

// The dashboard calls this "user".
router.get("/me", requireStaff, (req, res) => {
  res.json({ user: publicStaff(req.staff), staff: publicStaff(req.staff) });
});

module.exports = router;
