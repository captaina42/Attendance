// One SQLite database shared by the lecturer dashboard and the student app.
const { DatabaseSync } = require("node:sqlite");
const { DB_FILE } = require("./config");

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    id             INTEGER PRIMARY KEY,
    full_name      TEXT NOT NULL,
    student_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    department     TEXT NOT NULL DEFAULT '',
    level          TEXT NOT NULL DEFAULT '',
    password_hash  TEXT NOT NULL,
    credential_id  TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS courses (
    id         INTEGER PRIMARY KEY,
    code       TEXT NOT NULL,
    title      TEXT NOT NULL,
    level      TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (code, level)
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    id         INTEGER PRIMARY KEY,
    course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE (course_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS attendance_sessions (
    id                INTEGER PRIMARY KEY,
    code              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    course_id         INTEGER NOT NULL REFERENCES courses(id),
    staff_id          INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    level             TEXT NOT NULL,
    duration_seconds  INTEGER NOT NULL,
    remaining_seconds INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ACTIVE','CLOSED','EXPIRED')),
    created_at        INTEGER NOT NULL,
    activated_at      INTEGER,
    expires_at        INTEGER,
    closed_at         INTEGER
  );

  CREATE TABLE IF NOT EXISTS attendance_records (
    id                   INTEGER PRIMARY KEY,
    session_id           INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    student_id           INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    submitted_at         INTEGER NOT NULL,
    photo_path           TEXT NOT NULL DEFAULT '',
    photo_hash           TEXT NOT NULL DEFAULT '',
    face_verified        INTEGER NOT NULL DEFAULT 0,
    fingerprint_verified INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('verified','pending','flagged')),
    UNIQUE (session_id, student_id)
  );

  CREATE TABLE IF NOT EXISTS verification_logs (
    id            INTEGER PRIMARY KEY,
    attendance_id INTEGER REFERENCES attendance_records(id) ON DELETE CASCADE,
    session_id    INTEGER NOT NULL,
    student_id    INTEGER NOT NULL,
    method        TEXT NOT NULL,
    ok            INTEGER NOT NULL DEFAULT 1,
    detail        TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flagged_submissions (
    id            INTEGER PRIMARY KEY,
    attendance_id INTEGER NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
    session_id    INTEGER NOT NULL,
    student_id    INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER,
    resolved_by   INTEGER
  );

  -- Short-lived WebAuthn challenges, kept in the database so a restart or a second
  -- instance cannot replay or lose a pending ceremony.
  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    challenge  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_status ON attendance_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_staff ON attendance_sessions(staff_id);
  CREATE INDEX IF NOT EXISTS idx_records_session ON attendance_records(session_id);
  CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id);
`);

// --- migrations for databases created by an earlier version ---
const studentColumns = db.prepare("PRAGMA table_info(students)").all().map((c) => c.name);
function addStudentColumn(name, definition) {
  if (!studentColumns.includes(name)) db.exec(`ALTER TABLE students ADD COLUMN ${definition}`);
}
// The passkey public key must be stored to verify assertions; the id alone proves nothing.
addStudentColumn("credential_public_key", "credential_public_key TEXT NOT NULL DEFAULT ''");
addStudentColumn("credential_counter", "credential_counter INTEGER NOT NULL DEFAULT 0");
addStudentColumn("credential_transports", "credential_transports TEXT NOT NULL DEFAULT ''");
addStudentColumn("credential_device_type", "credential_device_type TEXT NOT NULL DEFAULT ''");
addStudentColumn("credential_backed_up", "credential_backed_up INTEGER NOT NULL DEFAULT 0");
addStudentColumn("credential_created_at", "credential_created_at INTEGER NOT NULL DEFAULT 0");
// Credential ids recorded before signature verification existed are useless (no public key).
db.exec("UPDATE students SET credential_id = '' WHERE credential_id <> '' AND credential_public_key = ''");

const LEVELS = ["100 Level", "200 Level", "300 Level", "400 Level", "500 Level", "600 Level"];

module.exports = { db, LEVELS };
