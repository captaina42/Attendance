// Attendance records for the lecturer dashboard (records, flagged and export pages).
const express = require("express");
const fs = require("fs");
const path = require("path");
const { db } = require("../db");
const { requireStaff, sameOrigin } = require("../middleware/auth");
const { PHOTO_DIR } = require("../config");
const { auditLog } = require("../lib/sessions");

const router = express.Router();
router.use(requireStaff);

const presentStatus = (status) => (status === "flagged" ? "flagged" : "present");

function listRecords(staffId, { sessionId = null } = {}) {
  const rows = db
    .prepare(
      `SELECT r.id, r.session_id, r.submitted_at, r.status, r.face_verified, r.fingerprint_verified,
              r.photo_path, r.photo_hash, r.photo_phash, r.photo_validation_status, r.photo_validation_detail,
              r.photo_mime, r.photo_size, r.device_detail, r.face_count_reported,
              st.id AS student_pk, st.student_number, st.full_name, c.code AS course_code, c.title AS course_title,
              s.code AS session_code, s.level, s.staff_id,
              (SELECT f.id FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_id,
              (SELECT f.reason FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_reason,
              (SELECT f.severity FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_severity,
              (SELECT f.detection_result FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_detection,
              (SELECT f.review_status FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_review_status,
              (SELECT f.review_notes FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_review_notes,
              (SELECT f.reviewed_at FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_reviewed_at,
              (SELECT f.reviewed_by FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_reviewed_by,
              (SELECT f.created_at FROM flagged_submissions f WHERE f.attendance_id = r.id AND f.resolved_at IS NULL ORDER BY f.id DESC LIMIT 1) AS flag_created_at
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
    studentPk: r.student_pk,
    name: r.full_name,
    course: `${r.course_code} - ${r.course_title}`,
    courseCode: r.course_code,
    courseTitle: r.course_title,
    level: r.level,
    markedAt: r.submitted_at,
    status: presentStatus(r.status),
    recordStatus: r.status,
    sessionId: r.session_id,
    sessionCode: r.session_code,
    faceVerified: Boolean(r.face_verified),
    fingerprintVerified: Boolean(r.fingerprint_verified),
    flagReason: r.flag_reason || "",
    flagId: r.flag_id || null,
    flagSeverity: r.flag_severity || "",
    flagDetection: r.flag_detection || "",
    flagReviewStatus: r.flag_review_status || (r.status === "flagged" ? "PENDING REVIEW" : ""),
    flagReviewNotes: r.flag_review_notes || "",
    flagReviewedAt: r.flag_reviewed_at || 0,
    flagReviewedBy: r.flag_reviewed_by || null,
    flagCreatedAt: r.flag_created_at || 0,
    photoValidationStatus: r.photo_validation_status || "",
    photoValidationDetail: r.photo_validation_detail || "",
    photoPath: r.photo_path || "",
    photoHash: r.photo_hash || "",
    photoPhash: r.photo_phash || "",
    photoMime: r.photo_mime || "",
    photoSize: r.photo_size || 0,
    deviceDetail: r.device_detail || "",
    faceCountReported: r.face_count_reported,
    hasPhoto: Boolean(r.photo_path),
  }));
}

router.get("/", (req, res) => {
  const sessionId = req.query.session ? Number(req.query.session) : null;
  res.json({ records: listRecords(req.staff.id, { sessionId }) });
});

router.get("/flagged", (req, res) => {
  res.json({ flagged: listRecords(req.staff.id).filter((r) => r.status === "flagged") });
});

// Detail for the "View Student Photo" modal.
router.get("/:id/detail", (req, res) => {
  const record = db
    .prepare(
      `SELECT r.*, st.full_name, st.student_number, st.email, st.department, st.level,
              s.code AS session_code, s.level AS session_level, c.code AS course_code, c.title AS course_title,
              (SELECT f.reason FROM flagged_submissions f WHERE f.attendance_id = r.id ORDER BY f.id DESC LIMIT 1) AS flag_reason,
              (SELECT f.severity FROM flagged_submissions f WHERE f.attendance_id = r.id ORDER BY f.id DESC LIMIT 1) AS flag_severity,
              (SELECT f.detection_result FROM flagged_submissions f WHERE f.attendance_id = r.id ORDER BY f.id DESC LIMIT 1) AS flag_detection,
              (SELECT f.review_status FROM flagged_submissions f WHERE f.attendance_id = r.id ORDER BY f.id DESC LIMIT 1) AS flag_review_status,
              (SELECT f.review_notes FROM flagged_submissions f WHERE f.attendance_id = r.id ORDER BY f.id DESC LIMIT 1) AS flag_review_notes,
              (SELECT f.reviewed_at FROM flagged_submissions f WHERE f.attendance_id = r.id ORDER BY f.id DESC LIMIT 1) AS flag_reviewed_at
       FROM attendance_records r
       JOIN students st ON st.id = r.student_id
       JOIN attendance_sessions s ON s.id = r.session_id
       JOIN courses c ON c.id = s.course_id
       WHERE r.id = ? AND s.staff_id = ?`,
    )
    .get(Number(req.params.id), req.staff.id);
  if (!record) return res.status(404).json({ error: "Record not found." });

  // Verification audit for this record.
  const logs = db
    .prepare("SELECT method, ok, detail, created_at FROM verification_logs WHERE attendance_id = ? ORDER BY created_at ASC")
    .all(record.id);

  res.json({
    record: {
      id: record.id,
      studentName: record.full_name,
      studentNumber: record.student_number,
      email: record.email,
      department: record.department,
      level: record.level,
      course: `${record.course_code} - ${record.course_title}`,
      sessionCode: record.session_code,
      markedAt: record.submitted_at,
      status: record.status,
      faceVerified: Boolean(record.face_verified),
      fingerprintVerified: Boolean(record.fingerprint_verified),
      photoValidationStatus: record.photo_validation_status,
      photoValidationDetail: record.photo_validation_detail,
      photoMime: record.photo_mime,
      photoSize: record.photo_size,
      deviceDetail: record.device_detail,
      faceCountReported: record.face_count_reported,
      flagReason: record.flag_reason || "",
      flagSeverity: record.flag_severity || "",
      flagDetection: record.flag_detection || "",
      flagReviewStatus: record.flag_review_status || (record.status === "flagged" ? "PENDING REVIEW" : ""),
      flagReviewNotes: record.flag_review_notes || "",
      flagReviewedAt: record.flag_reviewed_at || 0,
      hasPhoto: Boolean(record.photo_path),
      verificationLogs: logs,
    },
  });
});

// Secure photo stream (staff-only, ownership checked).
router.get("/:id/photo", (req, res) => {
  const row = db
    .prepare(
      `SELECT r.photo_path, r.photo_mime FROM attendance_records r
       JOIN attendance_sessions s ON s.id = r.session_id
       WHERE r.id = ? AND s.staff_id = ?`,
    )
    .get(Number(req.params.id), req.staff.id);
  if (!row || !row.photo_path) return res.status(404).json({ error: "Photo not found." });

  const filePath = path.join(PHOTO_DIR, path.basename(row.photo_path));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Photo not found." });

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", row.photo_mime || "image/jpeg");
  res.sendFile(filePath);
});

// Legacy toggle + new review workflow. Supports both:
//   { status: "present"|"flagged" }   (old behaviour)
//   { reviewStatus: "CLEARED"|"CONFIRMED", notes: "..." }
router.patch("/:id", sameOrigin, (req, res) => {
  const record = db
    .prepare(
      `SELECT r.* FROM attendance_records r
       JOIN attendance_sessions s ON s.id = r.session_id
       WHERE r.id = ? AND s.staff_id = ?`,
    )
    .get(Number(req.params.id), req.staff.id);
  if (!record) return res.status(404).json({ error: "Record not found." });

  const reviewStatus = String(req.body?.reviewStatus || "").toUpperCase();
  if (reviewStatus === "CLEARED" || reviewStatus === "CONFIRMED") {
    const notes = String(req.body?.notes || "").trim().slice(0, 1000);
    // Find the open flag.
    const openFlag = db
      .prepare("SELECT * FROM flagged_submissions WHERE attendance_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(record.id);

    const previous = openFlag ? openFlag.review_status : (record.status === "flagged" ? "PENDING REVIEW" : record.status);
    db.prepare(
      `UPDATE flagged_submissions SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_notes = ?,
        previous_status = ?, new_status = ?, resolved_at = ?, resolved_by = ?
       WHERE id = ?`,
    ).run(
      reviewStatus,
      req.staff.id,
      Date.now(),
      notes,
      previous,
      reviewStatus,
      reviewStatus === "CLEARED" ? Date.now() : null,
      reviewStatus === "CLEARED" ? req.staff.id : null,
      openFlag ? openFlag.id : null,
    );

    // If no open flag row exists (lecturer flagging a clean record), create one for the audit trail.
    if (!openFlag) {
      db.prepare(
        `INSERT INTO flagged_submissions (attendance_id, session_id, student_id, reason, severity, detection_result, review_status, reviewed_by, reviewed_at, review_notes, previous_status, new_status, created_at, resolved_at, resolved_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.id,
        record.session_id,
        record.student_id,
        "Reviewed by lecturer",
        "low",
        "",
        reviewStatus,
        req.staff.id,
        Date.now(),
        notes,
        previous,
        reviewStatus,
        Date.now(),
        reviewStatus === "CLEARED" ? Date.now() : null,
        reviewStatus === "CLEARED" ? req.staff.id : null,
      );
    }

    // Update the attendance record status.
    const newRecordStatus = reviewStatus === "CLEARED" ? "verified" : "flagged";
    db.prepare("UPDATE attendance_records SET status = ? WHERE id = ?").run(newRecordStatus, record.id);

    auditLog({
      actorRole: "staff",
      actorId: req.staff.id,
      action: "flag_reviewed",
      entityType: "attendance_record",
      entityId: record.id,
      oldValue: previous,
      newValue: reviewStatus,
      detail: notes,
    });

    return res.json({ record: listRecords(req.staff.id).find((r) => r.id === record.id) });
  }

  // Legacy toggle.
  const status = String(req.body?.status || "").toLowerCase();
  if (!["present", "flagged", "verified"].includes(status))
    return res.status(400).json({ error: "Status must be 'present' or 'flagged'." });

  const next = status === "flagged" ? "flagged" : "verified";
  db.prepare("UPDATE attendance_records SET status = ? WHERE id = ?").run(next, record.id);

  if (next === "verified") {
    db.prepare(
      "UPDATE flagged_submissions SET resolved_at = ?, resolved_by = ?, review_status = 'CLEARED' WHERE attendance_id = ? AND resolved_at IS NULL",
    ).run(Date.now(), req.staff.id, record.id);
  } else if (record.status !== "flagged") {
    db.prepare(
      `INSERT INTO flagged_submissions (attendance_id, session_id, student_id, reason, created_at, review_status)
       VALUES (?,?,?,?,?,'PENDING REVIEW')`,
    ).run(record.id, record.session_id, record.student_id, "Flagged by lecturer for review", Date.now());
  }

  auditLog({
    actorRole: "staff",
    actorId: req.staff.id,
    action: "record_status_changed",
    entityType: "attendance_record",
    entityId: record.id,
    oldValue: record.status,
    newValue: next,
    detail: "",
  });

  res.json({ record: listRecords(req.staff.id).find((r) => r.id === record.id) });
});

module.exports = router;
module.exports.listRecords = listRecords;
