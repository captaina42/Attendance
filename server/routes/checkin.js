// Legacy public code-only check-in page (checkin.html), kept for compatibility.
// A submission made without face + fingerprint verification is recorded as flagged
// so the lecturer has to review it.
const express = require("express");
const { db } = require("../db");
const { sameOrigin } = require("../middleware/auth");
const { settle, shape, recordFor, flagSubmission, logVerification } = require("../lib/sessions");

const router = express.Router();

router.post("/", sameOrigin, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const studentNumber = String(req.body?.studentNumber || "").trim();

  if (!code) return res.status(400).json({ error: "Enter the attendance code." });
  if (!studentNumber) return res.status(400).json({ error: "Enter your student number." });

  const row = db.prepare("SELECT * FROM attendance_sessions WHERE code = ?").get(code);
  if (!row) return res.status(404).json({ error: "No attendance session has that code." });

  const session = settle(row);
  if (session.status === "PENDING")
    return res.status(409).json({ error: "This session has not been activated by the lecturer yet." });
  if (session.status !== "ACTIVE")
    return res.status(410).json({ error: "Attendance session closed." });

  const student = db.prepare("SELECT * FROM students WHERE student_number = ?").get(studentNumber);
  if (!student)
    return res
      .status(404)
      .json({ error: "No registered student has that number. Use the AttendSecure student app." });
  if (recordFor(session.id, student.id))
    return res.status(409).json({ error: "Attendance already submitted for this session." });

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO attendance_records
        (session_id, student_id, submitted_at, photo_path, photo_hash, face_verified, fingerprint_verified, status)
       VALUES (?,?,?,'','',0,0,'flagged')`,
    )
    .run(session.id, student.id, now);
  const attendanceId = Number(info.lastInsertRowid);
  flagSubmission({
    attendanceId,
    sessionId: session.id,
    studentId: student.id,
    reason: "Checked in with the code only - no face or fingerprint verification",
  });
  logVerification({
    attendanceId,
    sessionId: session.id,
    studentId: student.id,
    method: "checkin",
    detail: "Code-only check-in",
  });

  res.status(201).json({
    session: shape(session),
    record: {
      id: attendanceId,
      studentId: student.student_number,
      name: student.full_name,
      status: "flagged",
      markedAt: now,
    },
  });
});

module.exports = router;
