// Attendance records for the lecturer dashboard (records, flagged and export pages).
const express = require("express");
const { db } = require("../db");
const { requireStaff, sameOrigin } = require("../middleware/auth");

const router = express.Router();
router.use(requireStaff);

// The dashboard speaks "present"/"flagged"; verification details live on the record.
const presentStatus = (status) => (status === "flagged" ? "flagged" : "present");

function listRecords(staffId, { sessionId = null } = {}) {
  const rows = db
    .prepare(
      `SELECT r.id, r.session_id, r.submitted_at, r.status, r.face_verified, r.fingerprint_verified,
              st.student_number, st.full_name, c.code AS course_code, c.title AS course_title,
              s.code AS session_code, s.level,
              (SELECT f.reason FROM flagged_submissions f
                WHERE f.attendance_id = r.id AND f.resolved_at IS NULL
                ORDER BY f.id DESC LIMIT 1) AS flag_reason
       FROM attendance_records r
       JOIN students st ON st.id = r.student_id
       JOIN attendance_sessions s ON s.id = r.session_id
       JOIN courses c ON c.id = s.course_id
       WHERE s.staff_id = ? ${sessionId ? "AND r.session_id = ?" : ""}
       ORDER BY r.submitted_at DESC
       LIMIT 500`,
    )
    .all(...(sessionId ? [staffId, sessionId] : [staffId]));

  return rows.map((r) => ({
    id: r.id,
    studentId: r.student_number,
    name: r.full_name,
    course: `${r.course_code} - ${r.course_title}`,
    level: r.level,
    markedAt: r.submitted_at,
    status: presentStatus(r.status),
    recordStatus: r.status,
    sessionId: r.session_id,
    sessionCode: r.session_code,
    faceVerified: Boolean(r.face_verified),
    fingerprintVerified: Boolean(r.fingerprint_verified),
    flagReason: r.flag_reason || "",
  }));
}

router.get("/", (req, res) => {
  const sessionId = req.query.session ? Number(req.query.session) : null;
  res.json({ records: listRecords(req.staff.id, { sessionId }) });
});

router.get("/flagged", (req, res) => {
  res.json({ flagged: listRecords(req.staff.id).filter((r) => r.status === "flagged") });
});

// Lecturer review: mark a flagged submission as verified, or flag a clean one.
router.patch("/:id", sameOrigin, (req, res) => {
  const status = String(req.body?.status || "").toLowerCase();
  if (!["present", "flagged", "verified"].includes(status))
    return res.status(400).json({ error: "Status must be 'present' or 'flagged'." });

  const record = db
    .prepare(
      `SELECT r.* FROM attendance_records r
       JOIN attendance_sessions s ON s.id = r.session_id
       WHERE r.id = ? AND s.staff_id = ?`,
    )
    .get(Number(req.params.id), req.staff.id);
  if (!record) return res.status(404).json({ error: "Record not found." });

  const next = status === "flagged" ? "flagged" : "verified";
  db.prepare("UPDATE attendance_records SET status = ? WHERE id = ?").run(next, record.id);

  if (next === "verified") {
    db.prepare(
      "UPDATE flagged_submissions SET resolved_at = ?, resolved_by = ? WHERE attendance_id = ? AND resolved_at IS NULL",
    ).run(Date.now(), req.staff.id, record.id);
  } else if (record.status !== "flagged") {
    db.prepare(
      `INSERT INTO flagged_submissions (attendance_id, session_id, student_id, reason, created_at)
       VALUES (?,?,?,?,?)`,
    ).run(
      record.id,
      record.session_id,
      record.student_id,
      "Flagged by lecturer for review",
      Date.now(),
    );
  }

  res.json({ record: listRecords(req.staff.id).find((r) => r.id === record.id) });
});

module.exports = router;
module.exports.listRecords = listRecords;
