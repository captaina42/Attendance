// Student app API. Ported from the standalone student project, now reading the shared
// database and only ever exposing sessions the lecturer has ACTIVATED.
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { db, LEVELS } = require("../db");
const { PHOTO_DIR, BIOMETRIC_FRESHNESS_MS } = require("../config");
const {
  requireStudent,
  issueStudentSession,
  clearStudentSession,
  sameOrigin,
} = require("../middleware/auth");
const {
  relyingParty,
  registrationOptions,
  authenticationOptions,
  verifyRegistration,
  verifyAssertion,
  forgetCredential,
} = require("../lib/webauthn");
const {
  settle,
  shape,
  courseFor,
  enrolled,
  ensureEnrolled,
  recordFor,
  logVerification,
  flagSubmission,
  auditLog,
} = require("../lib/sessions");
const { validatePhoto, hamming } = require("../lib/photoValidation");
const { broadcast } = require("../lib/events");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// Passkey challenges live in the database (see lib/webauthn.js). Only the "verified a
// moment ago" timestamp is in memory: it is a 5 minute grace period, not an entitlement.
const biometricAt = new Map(); // studentId -> timestamp of a successful assertion
const fresh = (studentId) => {
  const at = biometricAt.get(studentId);
  return at && Date.now() - at < BIOMETRIC_FRESHNESS_MS ? at : 0;
};

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const publicStudent = (s) => ({
  id: s.id,
  studentNumber: s.student_number,
  fullName: s.full_name,
  email: s.email,
  department: s.department,
  level: s.level,
  // A passkey is only usable when its public key was stored at registration.
  biometricEnrolled: Boolean(s.credential_id && s.credential_public_key),
  biometricDevice: s.credential_device_type || "",
});
const publicSession = (s) => {
  const row = shape(s);
  return {
    id: row.id,
    code: row.code,
    course: row.course,
    courseCode: row.courseCode,
    courseTitle: row.courseTitle,
    level: row.level,
    lecturer: row.lecturer,
    status: row.status,
    startsAt: row.activatedAt || row.createdAt,
    endsAt: row.expiresAt,
    duration: row.duration,
    secondsLeft: row.secondsLeft,
    remainingSeconds: row.remainingSeconds,
  };
};

// A student may attend a session only for their own level (and department, if the course has one).
function eligible(student, course, session) {
  if (course.level && course.level !== student.level) return false;
  if (course.department && course.department.toLowerCase() !== student.department.toLowerCase())
    return false;
  if (session.level && session.level !== student.level) return false;
  return true;
}

router.post("/register", sameOrigin, authLimiter, (req, res) => {
  const studentNumber = clean(req.body?.studentNumber);
  const fullName = clean(req.body?.fullName);
  const email = clean(req.body?.email).toLowerCase();
  const department = clean(req.body?.department);
  const level = clean(req.body?.level);
  const password = req.body?.password;

  if (studentNumber.length < 3 || studentNumber.length > 40)
    return res.status(400).json({ error: "Enter a valid student number." });
  if (fullName.length < 2 || fullName.length > 100)
    return res.status(400).json({ error: "Enter your full name." });
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120)
    return res.status(400).json({ error: "Enter a valid email address." });
  if (department.length < 2 || department.length > 80)
    return res.status(400).json({ error: "Enter your department." });
  if (!LEVELS.includes(level)) return res.status(400).json({ error: "Select your level." });
  if (typeof password !== "string" || password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const info = db
      .prepare(
        `INSERT INTO students (full_name, student_number, email, department, level, password_hash, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        fullName,
        studentNumber,
        email,
        department,
        level,
        bcrypt.hashSync(password, 10),
        Date.now(),
      );
    const student = db.prepare("SELECT * FROM students WHERE id = ?").get(Number(info.lastInsertRowid));
    issueStudentSession(res, student);
    res.status(201).json({ student: publicStudent(student) });
  } catch (e) {
    if (String(e.message).includes("UNIQUE"))
      return res.status(409).json({ error: "That student number or email is already registered." });
    console.error(e);
    res.status(500).json({ error: "Could not create account. Check the server terminal." });
  }
});

router.post("/login", sameOrigin, authLimiter, (req, res) => {
  const identifier = clean(req.body?.identifier);
  const student = identifier
    ? db
        .prepare(
          "SELECT * FROM students WHERE student_number = ? COLLATE NOCASE OR email = ? COLLATE NOCASE",
        )
        .get(identifier, identifier)
    : null;
  if (!student || !bcrypt.compareSync(String(req.body?.password || ""), student.password_hash))
    return res.status(401).json({ error: "Incorrect student number/email or password." });
  issueStudentSession(res, student);
  res.json({ student: publicStudent(student) });
});

router.post("/logout", sameOrigin, (req, res) => {
  clearStudentSession(res);
  res.json({ ok: true });
});

router.get("/me", requireStudent, (req, res) => {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(req.student.id);
  if (!student) {
    clearStudentSession(res);
    return res.status(401).json({ error: "Please log in again." });
  }
  res.json({ student: publicStudent(student) });
});

// Live sessions for this student: only ACTIVE ones, only their own class.
router.get("/sessions", requireStudent, (req, res) => {
  const student = req.student;
  const rows = db
    .prepare("SELECT * FROM attendance_sessions WHERE status = 'ACTIVE' ORDER BY created_at DESC")
    .all()
    .map(settle)
    .filter((s) => s.status === "ACTIVE");

  const sessions = [];
  for (const row of rows) {
    const course = courseFor(row.course_id);
    if (!course || !eligible(student, course, row)) continue;
    ensureEnrolled(row.course_id, student.id);
    sessions.push({ ...publicSession(row), submitted: Boolean(recordFor(row.id, student.id)) });
  }
  res.json({ sessions });
});

// Look a session up by the code the lecturer put on screen.
router.get("/session/:code", requireStudent, (req, res) => {
  const code = clean(req.params.code).toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter the attendance code from your lecturer." });

  const row = db
    .prepare("SELECT * FROM attendance_sessions WHERE code = ? COLLATE NOCASE")
    .get(code);
  if (!row) return res.status(404).json({ error: "That code is invalid or not active." });

  const session = settle(row);
  if (session.status === "PENDING")
    return res
      .status(409)
      .json({ error: "This session has not been activated by your lecturer yet." });
  if (session.status !== "ACTIVE")
    return res.status(410).json({ error: "Attendance session closed." });

  const course = courseFor(session.course_id);
  if (!eligible(req.student, course, session))
    return res.status(403).json({ error: "This session is not for your class or level." });

  ensureEnrolled(session.course_id, req.student.id);
  res.json({
    session: publicSession(session),
    submitted: Boolean(recordFor(session.id, req.student.id)),
  });
});

// Step 2: biometric verification with a real passkey (WebAuthn platform authenticator).
router.post("/biometric/challenge", requireStudent, async (req, res) => {
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(req.student.id);
  if (!student) return res.status(401).json({ error: "Please log in again." });
  try {
    const enrolled = Boolean(student.credential_id && student.credential_public_key);
    const mode = enrolled ? "authenticate" : "register";
    const options = enrolled
      ? await authenticationOptions(req, student)
      : await registrationOptions(req, student);
    res.json({
      mode,
      options,
      rpId: relyingParty(req).rpID,
      enrolled,
      device: student.credential_device_type || "",
    });
  } catch (e) {
    console.error("webauthn options", e);
    res.status(500).json({ error: "Could not start biometric verification. Try again." });
  }
});

router.post("/biometric/verify", requireStudent, sameOrigin, async (req, res) => {
  const studentId = req.student.id;
  const student = db.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
  const { mode, credential } = req.body || {};
  const fail = (status, message, detail) => {
    logVerification({ sessionId: 0, studentId, method: "fingerprint", ok: 0, detail });
    return res.status(status).json({ error: message });
  };

  if (!credential || typeof credential !== "object" || !credential.id)
    return fail(400, "Biometric verification failed. Try again.", "Missing credential response");

  try {
    if (mode === "register") {
      if (student.credential_id) return fail(409, "This account already has a passkey.", "Duplicate enrolment");
      const info = await verifyRegistration(req, student, credential);
      // Enrolment also required a fingerprint/face check on this device, so it counts as
      // a fresh user verification for the submission that follows.
      biometricAt.set(studentId, Date.now());
      logVerification({
        sessionId: 0,
        studentId,
        method: "fingerprint",
        detail: `Passkey enrolled (${info.counter === 0 ? "no counter" : "counter " + info.counter})`,
      });
      return res.json({
        verified: true,
        enrolled: true,
        mode: "register",
        freshnessMs: BIOMETRIC_FRESHNESS_MS,
      });
    }

    const info = await verifyAssertion(req, student, credential);
    biometricAt.set(studentId, Date.now());
    logVerification({
      sessionId: 0,
      studentId,
      method: "fingerprint",
      detail: `Passkey assertion verified (uv=${info.userVerified}, counter=${info.newCounter})`,
    });
    res.json({ verified: true, enrolled: true, mode: "authenticate", freshnessMs: BIOMETRIC_FRESHNESS_MS });
  } catch (e) {
    const detail = String(e && e.message ? e.message : e);
    console.error("webauthn verify", detail);
    // Verification errors are deliberately generic for the user but logged in full.
    if (/cloned|no passkey/i.test(detail)) return fail(409, detail, detail);
    if (/expired/i.test(detail))
      return fail(400, "The verification request expired. Please try again.", detail);
    fail(401, "Biometric verification failed. Try again.", detail);
  }
});

// Re-enrol from a new phone: the student's own signed-in session is enough to drop the old key.
router.delete("/biometric/credential", requireStudent, sameOrigin, (req, res) => {
  forgetCredential(req.student.id);
  biometricAt.delete(req.student.id);
  logVerification({
    sessionId: 0,
    studentId: req.student.id,
    method: "fingerprint",
    detail: "Passkey removed by the student",
  });
  res.json({ ok: true, enrolled: false });
});

// Step 3: submit attendance. The photo is mandatory and the session must still be ACTIVE.
router.post("/attendance", requireStudent, sameOrigin, async (req, res) => {
  const studentId = req.student.id;
  const code = clean(req.body?.code).toUpperCase();
  const photo = req.body?.photo;
  const faceCount = req.body?.faceCount;
  const now = Date.now();

  if (!code) return res.status(400).json({ error: "Enter the attendance code from your lecturer." });
  const match =
    typeof photo === "string" && photo.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: "Capture your photo to complete attendance." });
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length < 500)
    return res.status(400).json({ error: "That photo was too small. Capture again." });
  if (buffer.length > 5 * 1024 * 1024)
    return res.status(413).json({ error: "That photo is too large." });

  // Server-side validation of the actual image (decode, quality, perceptual hash, hints).
  let validation;
  try {
    validation = await validatePhoto(buffer, { faceCount });
  } catch (e) {
    console.error("photo validation", e);
    return res.status(400).json({ error: "Could not process that photo. Capture again." });
  }
  if (!validation.ok && /corrupt|unsupported|unrecognised|resolution is too low/i.test(validation.reasons.join(" "))) {
    // Hard failures: do not store.
    const hard = validation.reasons.find((r) => /corrupt|unsupported|unrecognised|resolution/i.test(r));
    return res.status(400).json({ error: hard || "Invalid photo. Capture again." });
  }

  const row = db
    .prepare("SELECT * FROM attendance_sessions WHERE code = ? COLLATE NOCASE")
    .get(code);
  if (!row) return res.status(404).json({ error: "That code is invalid or not active." });

  const session = settle(row);
  if (session.status === "PENDING")
    return res.status(409).json({ error: "This session has not been activated by your lecturer yet." });
  if (session.status !== "ACTIVE")
    return res.status(410).json({ error: "Attendance session closed." });

  const course = courseFor(session.course_id);
  if (!eligible(req.student, course, session))
    return res.status(403).json({ error: "This session is not for your class or level." });

  if (recordFor(session.id, studentId))
    return res.status(409).json({ error: "You have already submitted attendance for this session." });

  const fingerprintVerified = fresh(studentId) ? 1 : 0;
  const photoHash = crypto.createHash("sha256").update(buffer).digest("hex");
  // The same capture arriving from a second student is a duplicate-face signal for the lecturer.
  const twin = db
    .prepare(
      `SELECT r.id, st.full_name FROM attendance_records r
       JOIN students st ON st.id = r.student_id
       WHERE r.session_id = ? AND r.photo_hash <> '' AND r.photo_hash = ? AND r.student_id <> ?`,
    )
    .get(session.id, photoHash, studentId);

  // Reused photograph by the same student in an earlier session.
  const reused = db
    .prepare(
      `SELECT r.id, s.code FROM attendance_records r
       JOIN attendance_sessions s ON s.id = r.session_id
       WHERE r.student_id = ? AND r.photo_hash = ? AND r.session_id <> ?
       ORDER BY r.submitted_at DESC LIMIT 1`,
    )
    .get(studentId, photoHash, session.id);

  // Perceptual similarity against recent submissions (same session first, then global).
  let similarTo = null;
  if (validation.phash) {
    const candidates = db
      .prepare(
        `SELECT r.id, st.full_name, r.photo_phash FROM attendance_records r
         JOIN students st ON st.id = r.student_id
         WHERE r.photo_phash <> '' AND r.submitted_at > ? AND r.student_id <> ?
         ORDER BY r.submitted_at DESC LIMIT 200`,
      )
      .all(Date.now() - 90 * 24 * 60 * 60 * 1000, studentId);
    for (const c of candidates) {
      if (hamming(validation.phash, c.photo_phash) <= 10) { similarTo = c; break; }
    }
  }

  const flagReasons = [...validation.reasons];
  let severity = validation.severity || "low";
  if (twin) {
    flagReasons.push(`Same photo already submitted by ${twin.full_name} in this session`);
    severity = "high";
  }
  if (reused) {
    flagReasons.push(`Reused photograph from a previous session (${reused.code})`);
    severity = "high";
  }
  if (similarTo) {
    flagReasons.push(`Suspiciously similar to a photo submitted by ${similarTo.full_name}`);
    if (severity !== "high") severity = "medium";
  }

  const hasFlags = flagReasons.length > 0;
  const status = hasFlags ? "flagged" : fingerprintVerified ? "verified" : "pending";
  const ext = match[1] === "png" ? "png" : match[1] === "webp" ? "webp" : "jpg";
  const fileName = `${crypto.randomUUID()}.${ext}`;
  const relativePath = `photos/${fileName}`;
  fs.writeFileSync(path.join(PHOTO_DIR, fileName), buffer);

  try {
    ensureEnrolled(session.course_id, studentId);
    const info = db
      .prepare(
        `INSERT INTO attendance_records
          (session_id, student_id, submitted_at, photo_path, photo_hash, photo_phash, photo_mime, photo_size,
           face_verified, fingerprint_verified, status, photo_validation_status, photo_validation_detail, device_detail, face_count_reported)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
      )
      .run(
        session.id,
        studentId,
        now,
        relativePath,
        photoHash,
        validation.phash,
        validation.mime,
        buffer.length,
        fingerprintVerified,
        status,
        validation.ok ? "passed" : "flagged",
        flagReasons.join("; "),
        req.get("user-agent") || "",
        validation.faceCountReported,
      );
    const attendanceId = Number(info.lastInsertRowid);

    if (hasFlags) {
      flagSubmission({
        attendanceId,
        sessionId: session.id,
        studentId,
        reason: flagReasons.join("; "),
        severity,
        detectionResult: JSON.stringify({ validation, twin: twin && twin.full_name, reused: reused && reused.code, similarTo: similarTo && similarTo.full_name }),
      });
      auditLog({
        actorRole: "system",
        action: "flag_created",
        entityType: "attendance_record",
        entityId: attendanceId,
        newValue: status,
        detail: flagReasons.join("; "),
      });
      // Real-time alert to the lecturer who owns this session.
      if (session.staff_id) {
        const student = db.prepare("SELECT full_name, student_number FROM students WHERE id = ?").get(studentId);
        broadcast(session.staff_id, "flagged", {
          attendanceId,
          studentName: student.full_name,
          studentNumber: student.student_number,
          course: shape(session).course,
          sessionCode: session.code,
          reason: flagReasons.join("; "),
          severity,
          markedAt: now,
        });
      }
    }

    logVerification({ attendanceId, sessionId: session.id, studentId, method: "face", detail: "Live camera capture stored" });
    logVerification({
      attendanceId,
      sessionId: session.id,
      studentId,
      method: "fingerprint",
      ok: fingerprintVerified,
      detail: fingerprintVerified ? "Device biometric verified minutes before submission" : "No fresh fingerprint check",
    });

    biometricAt.delete(studentId);
    auditLog({
      actorRole: "student",
      actorId: studentId,
      action: "attendance_submitted",
      entityType: "attendance_record",
      entityId: attendanceId,
      newValue: status,
      detail: fingerprintVerified ? "device verified" : "no fresh device check",
    });
    res.status(201).json({
      message: "Attendance submitted successfully.",
      record: {
        id: attendanceId,
        course: shape(session).course,
        level: session.level,
        code: session.code,
        markedAt: now,
        status,
        faceVerified: true,
        fingerprintVerified: Boolean(fingerprintVerified),
      },
    });
  } catch (e) {
    fs.rmSync(path.join(PHOTO_DIR, fileName), { force: true });
    if (String(e.message).includes("UNIQUE"))
      return res.status(409).json({ error: "You have already submitted attendance for this session." });
    console.error(e);
    res.status(500).json({ error: "Could not submit attendance." });
  }
});

router.get("/history", requireStudent, (req, res) => {
  const records = db
    .prepare(
      `SELECT r.id, c.code || ' - ' || c.title AS course, s.level, s.code, r.submitted_at AS markedAt,
              r.status, r.face_verified AS faceVerified, r.fingerprint_verified AS fingerprintVerified,
              st.name AS lecturer
       FROM attendance_records r
       JOIN attendance_sessions s ON s.id = r.session_id
       JOIN courses c ON c.id = s.course_id
       JOIN staff st ON st.id = s.staff_id
       WHERE r.student_id = ?
       ORDER BY r.submitted_at DESC`,
    )
    .all(req.student.id)
    .map((r) => ({
      ...r,
      faceVerified: Boolean(r.faceVerified),
      fingerprintVerified: Boolean(r.fingerprintVerified),
    }));
  res.json({ records });
});

module.exports = router;
