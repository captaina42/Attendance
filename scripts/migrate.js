// One-time import: brings the existing lecturer account, the real student account and a
// small demo class into the unified database. Safe to run more than once.
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { db } = require("../server/db");
const { syncEnrollments } = require("../server/lib/sessions");

const STAFF_DB = "C:/Users/chiag/Desktop/Skynet attendance project/attendance-pro/data/attendance.db";
const STUDENT_DB = "C:/Users/chiag/Desktop/att student/AttendSecure_Student/data/attendsecure.db";

function openSource(file) {
  if (!fs.existsSync(file)) return null;
  return new DatabaseSync(file, { readOnly: true });
}

function importStaff() {
  const src = openSource(STAFF_DB);
  if (!src) return console.log("! Staff database not found - skipping lecturer import.");
  const rows = src.prepare("SELECT name, email, password_hash FROM users").all();
  let added = 0;
  for (const row of rows) {
    if (db.prepare("SELECT 1 FROM staff WHERE email = ?").get(row.email)) continue;
    db.prepare("INSERT INTO staff (name, email, password_hash, created_at) VALUES (?,?,?,?)").run(
      row.name,
      row.email.toLowerCase(),
      row.password_hash,
      Date.now(),
    );
    added++;
  }
  console.log(`Lecturers imported: ${added} new of ${rows.length} found (existing password hashes kept).`);
  src.close();
}

function importStudents() {
  const src = openSource(STUDENT_DB);
  if (!src) return console.log("! Student database not found - skipping student import.");
  const rows = src
    .prepare("SELECT student_number, full_name, email, department, level, password_hash, credential_id FROM students")
    .all();
  let added = 0;
  for (const row of rows) {
    if (db.prepare("SELECT 1 FROM students WHERE student_number = ?").get(row.student_number)) continue;
    db.prepare(
      `INSERT INTO students (full_name, student_number, email, department, level, password_hash, credential_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      row.full_name,
      row.student_number,
      row.email.toLowerCase(),
      row.department || "",
      row.level || "",
      row.password_hash,
      row.credential_id || "",
      Date.now(),
    );
    added++;
  }
  console.log(`Students imported: ${added} new of ${rows.length} found (existing password hashes kept).`);
  src.close();
}

function ensureCourse(code, title, level, department) {
  const found = db.prepare("SELECT id FROM courses WHERE code = ? AND level = ?").get(code, level);
  if (found) return found.id;
  const info = db
    .prepare("INSERT INTO courses (code, title, level, department, created_at) VALUES (?,?,?,?,?)")
    .run(code, title, level, department, Date.now());
  return Number(info.lastInsertRowid);
}

function seedDemoStudents() {
  const demo = [
    ["GOU/U25/SWE/11", "Amaka Nwosu", "amaka.nwosu@gouni.edu.ng"],
    ["GOU/U25/SWE/12", "Tunde Bakare", "tunde.bakare@gouni.edu.ng"],
    ["GOU/U25/SWE/13", "Ifeoma Eze", "ifeoma.eze@gouni.edu.ng"],
    ["GOU/U25/SWE/14", "Samuel Okoro", "samuel.okoro@gouni.edu.ng"],
  ];
  const hash = require("bcryptjs").hashSync("Student@123", 10);
  let added = 0;
  for (const [number, name, email] of demo) {
    if (db.prepare("SELECT 1 FROM students WHERE student_number = ?").get(number)) continue;
    db.prepare(
      `INSERT INTO students (full_name, student_number, email, department, level, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(name, number, email, "Software Engineering", "200 Level", hash, Date.now());
    added++;
  }
  console.log(`Demo classmates added: ${added} (password Student@123).`);
}

function main() {
  importStaff();
  importStudents();
  seedDemoStudents();

  const courses = [
    ["CSC 215", "Algorithm for Bioinformatics", "200 Level", "Software Engineering"],
    ["CSC 101", "Introduction to Computer Science", "100 Level", "Software Engineering"],
    ["SWE 301", "Software Engineering Principles", "300 Level", "Software Engineering"],
  ];
  for (const [code, title, level, department] of courses) {
    const id = ensureCourse(code, title, level, department);
    const n = syncEnrollments(id);
    console.log(`Course ${code} (${level}) ready - ${n} new enrollment(s).`);
  }

  const counts = [
    ["staff", db.prepare("SELECT COUNT(*) AS n FROM staff").get().n],
    ["students", db.prepare("SELECT COUNT(*) AS n FROM students").get().n],
    ["courses", db.prepare("SELECT COUNT(*) AS n FROM courses").get().n],
    ["enrollments", db.prepare("SELECT COUNT(*) AS n FROM enrollments").get().n],
    ["sessions", db.prepare("SELECT COUNT(*) AS n FROM attendance_sessions").get().n],
    ["records", db.prepare("SELECT COUNT(*) AS n FROM attendance_records").get().n],
  ];
  console.log("Database totals:", counts.map(([k, v]) => `${k}=${v}`).join("  "));
}

main();
