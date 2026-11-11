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
    severity      TEXT NOT NULL DEFAULT 'medium',
    detection_result TEXT NOT NULL DEFAULT '',
    review_status TEXT NOT NULL DEFAULT 'PENDING REVIEW'
                  CHECK (review_status IN ('PENDING REVIEW','CLEARED','CONFIRMED')),
    reviewed_by   INTEGER REFERENCES staff(id),
    reviewed_at   INTEGER,
    review_notes  TEXT NOT NULL DEFAULT '',
    previous_status TEXT NOT NULL DEFAULT '',
    new_status    TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    resolved_at   INTEGER,
    resolved_by   INTEGER
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY,
    actor_role  TEXT NOT NULL,
    actor_id    INTEGER,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    old_value   TEXT NOT NULL DEFAULT '',
    new_value   TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
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

// --- migrations for attendance_records (added for photo validation) ---
function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function addColumn(table, name, definition) {
  if (!tableColumns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
const recordCols = tableColumns("attendance_records");
addColumn("attendance_records", "photo_validation_status", "photo_validation_status TEXT NOT NULL DEFAULT ''");
addColumn("attendance_records", "photo_validation_detail", "photo_validation_detail TEXT NOT NULL DEFAULT ''");
addColumn("attendance_records", "photo_phash", "photo_phash TEXT NOT NULL DEFAULT ''");
addColumn("attendance_records", "photo_mime", "photo_mime TEXT NOT NULL DEFAULT ''");
addColumn("attendance_records", "photo_size", "photo_size INTEGER NOT NULL DEFAULT 0");
addColumn("attendance_records", "device_detail", "device_detail TEXT NOT NULL DEFAULT ''");
addColumn("attendance_records", "face_count_reported", "face_count_reported INTEGER");

// --- migrations for flagged_submissions (review workflow) ---
addColumn("flagged_submissions", "severity", "severity TEXT NOT NULL DEFAULT 'medium'");
addColumn("flagged_submissions", "detection_result", "detection_result TEXT NOT NULL DEFAULT ''");
addColumn("flagged_submissions", "review_status", "review_status TEXT NOT NULL DEFAULT 'PENDING REVIEW'");
addColumn("flagged_submissions", "reviewed_by", "reviewed_by INTEGER");
addColumn("flagged_submissions", "reviewed_at", "reviewed_at INTEGER");
addColumn("flagged_submissions", "review_notes", "review_notes TEXT NOT NULL DEFAULT ''");
addColumn("flagged_submissions", "previous_status", "previous_status TEXT NOT NULL DEFAULT ''");
addColumn("flagged_submissions", "new_status", "new_status TEXT NOT NULL DEFAULT ''");

// Backfill review_status for any old rows.
db.exec("UPDATE flagged_submissions SET review_status = 'PENDING REVIEW' WHERE review_status IS NULL OR review_status = ''");

db.exec("CREATE INDEX IF NOT EXISTS idx_records_phash ON attendance_records(photo_phash)");
db.exec("CREATE INDEX IF NOT EXISTS idx_flagged_review ON flagged_submissions(review_status)");

const LEVELS = ["100 Level", "200 Level", "300 Level", "400 Level", "500 Level", "600 Level"];

module.exports = { db, LEVELS };
