// Session lifecycle helpers shared by the lecturer routes and the student routes.
const crypto = require("crypto");
const { db } = require("../db");

// Codes students type in. 32-character alphabet with no I, O, 0 or 1 so they are easy to read.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-HJ-NP-Z2-9]{4,8}$/;

function randomCode(length = 6) {
  return Array.from({ length }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
}

function codeTaken(code) {
  return !!db.prepare("SELECT 1 FROM attendance_sessions WHERE code = ?").get(code);
}

function newCode() {
  for (let i = 0; i < 40; i++) {
    const code = randomCode();
    if (!codeTaken(code)) return code;
  }
  throw new Error("Could not generate a session code");
}

// ACTIVE sessions past their expiry become EXPIRED as soon as anybody looks at them.
function settle(session) {
  if (!session) return session;
  if (session.status === "ACTIVE" && session.expires_at && Date.now() >= session.expires_at) {
    db.prepare(
      "UPDATE attendance_sessions SET status='EXPIRED', remaining_seconds=0 WHERE id=? AND status='ACTIVE'",
    ).run(session.id);
    return { ...session, status: "EXPIRED", remaining_seconds: 0 };
  }
  return session;
}

function secondsLeft(session) {
  if (!session || session.status !== "ACTIVE" || !session.expires_at) return 0;
  return Math.max(0, Math.ceil((session.expires_at - Date.now()) / 1000));
}

const courseLabel = (course) => (course ? `${course.code} - ${course.title}` : "");

function courseFor(id) {
  return db.prepare("SELECT * FROM courses WHERE id = ?").get(id);
}

function shape(session, extra = {}) {
  const s = settle(session);
  const course = courseFor(s.course_id);
  const staff = db.prepare("SELECT id, name FROM staff WHERE id = ?").get(s.staff_id);
  return {
    id: s.id,
    code: s.code,
    courseId: s.course_id,
    course: courseLabel(course),
    courseCode: course ? course.code : "",
    courseTitle: course ? course.title : "",
    level: s.level,
    department: course ? course.department : "",
    lecturer: staff ? staff.name : "",
    duration: s.duration_seconds,
    remainingSeconds: s.remaining_seconds,
    status: s.status,
    createdAt: s.created_at,
    activatedAt: s.activated_at,
    expiresAt: s.expires_at,
    closedAt: s.closed_at,
    secondsLeft: secondsLeft(s),
    ...extra,
  };
}

// Students at the session's level (and department, when the course names one) are its roster.
function syncEnrollments(courseId) {
  const course = courseFor(courseId);
  if (!course) return 0;
  const students = course.department
    ? db
        .prepare("SELECT id FROM students WHERE level = ? AND department = ? COLLATE NOCASE")
        .all(course.level, course.department)
    : db.prepare("SELECT id FROM students WHERE level = ?").all(course.level);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO enrollments (course_id, student_id, created_at) VALUES (?,?,?)",
  );
  let added = 0;
  for (const s of students) added += Number(insert.run(courseId, s.id, Date.now()).changes || 0);
  return added;
}

function enrolled(courseId, studentId) {
  return !!db
    .prepare("SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?")
    .get(courseId, studentId);
}

function ensureEnrolled(courseId, studentId) {
  db.prepare(
    "INSERT OR IGNORE INTO enrollments (course_id, student_id, created_at) VALUES (?,?,?)",
  ).run(courseId, studentId, Date.now());
}

function recordFor(sessionId, studentId) {
  return db
    .prepare("SELECT * FROM attendance_records WHERE session_id = ? AND student_id = ?")
    .get(sessionId, studentId);
}

// Roster with who has submitted, who has not, and their verification state.
function roster(sessionId) {
  const session = db.prepare("SELECT * FROM attendance_sessions WHERE id = ?").get(sessionId);
  if (!session) return [];
  return db
    .prepare(
      `SELECT st.id AS studentId, st.student_number AS studentNumber, st.full_name AS name,
              st.level, st.department,
              r.id AS recordId, r.submitted_at AS submittedAt, r.status AS recordStatus,
              r.fingerprint_verified AS fingerprintVerified, r.face_verified AS faceVerified
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       LEFT JOIN attendance_records r ON r.session_id = ? AND r.student_id = st.id
       WHERE e.course_id = ?
       ORDER BY st.full_name COLLATE NOCASE`,
    )
    .all(sessionId, session.course_id)
    .map((r) => ({
      ...r,
      submitted: Boolean(r.recordId),
      fingerprintVerified: Boolean(r.fingerprintVerified),
      faceVerified: Boolean(r.faceVerified),
    }));
}

function submitted(sessionId) {
  return roster(sessionId).filter((r) => r.submitted);
}

function absent(sessionId) {
  return roster(sessionId).filter((r) => !r.submitted);
}

function flagged(sessionId) {
  return db
    .prepare(
      `SELECT r.id AS recordId, st.student_number AS studentNumber, st.full_name AS name,
              r.submitted_at AS submittedAt, r.status, f.reason, f.id AS flagId,
              f.resolved_at AS resolvedAt
       FROM attendance_records r
       JOIN students st ON st.id = r.student_id
       LEFT JOIN flagged_submissions f ON f.attendance_id = r.id AND f.resolved_at IS NULL
       WHERE r.session_id = ? AND r.status = 'flagged'
       ORDER BY r.submitted_at DESC`,
    )
    .all(sessionId);
}

function logVerification({ attendanceId = null, sessionId, studentId, method, ok = 1, detail = "" }) {
  db.prepare(
    `INSERT INTO verification_logs (attendance_id, session_id, student_id, method, ok, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(attendanceId, sessionId, studentId, method, ok ? 1 : 0, detail, Date.now());
}

function flagSubmission({ attendanceId, sessionId, studentId, reason }) {
  db.prepare(
    `INSERT INTO flagged_submissions (attendance_id, session_id, student_id, reason, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(attendanceId, sessionId, studentId, reason, Date.now());
}

module.exports = {
  CODE_RE,
  randomCode,
  codeTaken,
  newCode,
  settle,
  secondsLeft,
  courseLabel,
  courseFor,
  shape,
  syncEnrollments,
  enrolled,
  ensureEnrolled,
  recordFor,
  roster,
  submitted,
  absent,
  flagged,
  logVerification,
  flagSubmission,
};
