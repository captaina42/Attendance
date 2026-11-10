// Attendance sessions: created PENDING by staff, activated/deactivated/closed by staff only.
const express = require("express");
const { db, LEVELS } = require("../db");
const { requireStaff, sameOrigin } = require("../middleware/auth");
const {
  CODE_RE,
  newCode,
  codeTaken,
  settle,
  secondsLeft,
  shape,
  syncEnrollments,
  roster,
  submitted,
  absent,
  flagged,
} = require("../lib/sessions");

const router = express.Router();
router.use(requireStaff);

const DURATIONS = [30, 60, 120];

function report(session) {
  const s = settle(session);
  const sub = submitted(s.id);
  const miss = absent(s.id);
  const flags = flagged(s.id);
  return {
    session: shape(s),
    roster: roster(s.id),
    submitted: sub,
    absent: miss,
    flagged: flags,
    counts: {
      total: sub.length + miss.length,
      submitted: sub.length,
      absent: miss.length,
      flagged: flags.length,
    },
  };
}

function findCourse({ courseId, course }) {
  if (courseId) {
    return db.prepare("SELECT * FROM courses WHERE id = ?").get(Number(courseId)) || null;
  }
  const text = String(course || "").trim();
  if (!text) return null;
  return (
    db
      .prepare("SELECT * FROM courses WHERE code = ? COLLATE NOCASE OR title = ? COLLATE NOCASE")
      .get(text, text) || null
  );
}

// Staff-only ownership check for every /:id route.
function loadOwn(req, res) {
  const key = String(req.params.id || "").trim();
  const row = /^\d+$/.test(key)
    ? db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(Number(key))
    : db.prepare("SELECT * FROM attendance_sessions WHERE code = ?").get(key.toUpperCase());
  if (!row) {
    res.status(404).json({ error: "Session not found." });
    return null;
  }
  if (row.staff_id !== req.staff.id) {
    res.status(404).json({ error: "Session not found." });
    return null;
  }
  return row;
}

router.post("/", sameOrigin, (req, res) => {
  const duration = Number(req.body?.duration);
  const level = String(req.body?.level || "").trim();
  const requested = String(req.body?.code || "").trim().toUpperCase();

  if (!DURATIONS.includes(duration))
    return res.status(400).json({ error: "Choose a duration of 30, 60 or 120 seconds." });

  let course = findCourse({ courseId: req.body?.courseId, course: req.body?.course });

  // A brand new course typed into the form is registered on the fly.
  if (!course) {
    const text = String(req.body?.course || "").trim();
    if (!text) return res.status(400).json({ error: "Select a course." });
    if (!LEVELS.includes(level))
      return res.status(400).json({ error: "Choose a class/group (level) for this course." });
    const info = db
      .prepare("INSERT INTO courses (code, title, level, department, created_at) VALUES (?,?,?,?,?)")
      .run(text.toUpperCase(), text, level, "", Date.now());
    course = db.prepare("SELECT * FROM courses WHERE id = ?").get(Number(info.lastInsertRowid));
  }

  if (requested) {
    if (!CODE_RE.test(requested))
      return res
        .status(400)
        .json({ error: "Attendance codes are 4-8 letters/digits (no I, O, 0 or 1)." });
    if (codeTaken(requested))
      return res.status(409).json({ error: "That attendance code is already in use." });
  }

  const code = requested || newCode();
  const sessionLevel = level || course.level;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO attendance_sessions
        (code, course_id, staff_id, level, duration_seconds, remaining_seconds, status, created_at)
       VALUES (?,?,?,?,?,?,'PENDING',?)`,
    )
    .run(code, course.id, req.staff.id, sessionLevel, duration, duration, now);
  const session = db
    .prepare("SELECT * FROM attendance_sessions WHERE id = ?")
    .get(Number(info.lastInsertRowid));

  syncEnrollments(course.id);
  res.status(201).json(report(session));
});

// Used by the create-session page to show a code before the session is saved.
router.post("/code", sameOrigin, (req, res) => {
  res.json({ code: newCode() });
});

router.get("/", (req, res) => {
  const rows = db
    .prepare(
      "SELECT * FROM attendance_sessions WHERE staff_id = ? ORDER BY created_at DESC LIMIT 100",
    )
    .all(req.staff.id);
  const sessions = rows.map((row) => {
    const s = settle(row);
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS submitted,
                SUM(CASE WHEN status='flagged' THEN 1 ELSE 0 END) AS flagged
         FROM attendance_records WHERE session_id = ?`,
      )
      .get(s.id);
    return shape(s, {
      submitted: Number(counts.submitted || 0),
      flagged: Number(counts.flagged || 0),
      count: Number(counts.submitted || 0),
    });
  });
  res.json({ sessions });
});

// Everything the live page needs: status, countdown, roster, submitted, absent, flagged.
router.get("/:id/report", (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  res.json(report(row));
});

router.get("/:id", (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  res.json(report(row));
});

router.post("/:id/activate", sameOrigin, (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  const current = settle(row);

  if (current.status === "CLOSED")
    return res.status(409).json({ error: "This session was closed. Create a new one." });
  if (current.status === "ACTIVE")
    return res.status(409).json({ error: "This session is already active." });

  let duration = current.duration_seconds;
  if (req.body?.duration !== undefined) {
    const requested = Number(req.body.duration);
    if (!DURATIONS.includes(requested))
      return res.status(400).json({ error: "Choose a duration of 30, 60 or 120 seconds." });
    duration = requested;
  }

  const remaining = current.status === "PENDING" ? current.remaining_seconds || duration : 0;
  if (remaining <= 0)
    return res.status(409).json({ error: "This session ran out of time. Create a new one." });

  const now = Date.now();
  db.prepare(
    `UPDATE attendance_sessions
     SET status='ACTIVE', duration_seconds=?, expires_at=?, activated_at=COALESCE(activated_at, ?)
     WHERE id=?`,
  ).run(duration, now + remaining * 1000, now, current.id);

  syncEnrollments(current.course_id);
  const updated = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(current.id);
  res.json(report(updated));
});

// Pause: students can no longer see or submit, remaining time is preserved.
router.post("/:id/deactivate", sameOrigin, (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  const current = settle(row);

  if (current.status === "PENDING")
    return res.status(409).json({ error: "This session is already paused (pending)." });
  if (current.status === "CLOSED")
    return res.status(409).json({ error: "This session is closed." });
  if (current.status === "EXPIRED")
    return res.status(409).json({ error: "This session already expired." });

  const remaining = Math.max(0, secondsLeft(current));
  db.prepare(
    "UPDATE attendance_sessions SET status='PENDING', remaining_seconds=?, expires_at=NULL WHERE id=?",
  ).run(remaining, current.id);

  const updated = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(current.id);
  res.json(report(updated));
});

router.post("/:id/close", sameOrigin, (req, res) => {
  const row = loadOwn(req, res);
  if (!row) return;
  const current = settle(row);
  if (current.status === "CLOSED") return res.json(report(current));

  db.prepare(
    "UPDATE attendance_sessions SET status='CLOSED', remaining_seconds=0, closed_at=? WHERE id=?",
  ).run(Date.now(), current.id);

  const updated = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(current.id);
  res.json(report(updated));
});

module.exports = router;
