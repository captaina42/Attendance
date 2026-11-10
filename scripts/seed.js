// First-run bootstrap for a freshly deployed instance. Safe to run on every start:
// it only adds what is missing and never touches existing accounts or attendance data.
const bcrypt = require("bcryptjs");
const { db } = require("../server/db");

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const name = (process.env.ADMIN_NAME || "Lecturer").trim();
const password = process.env.ADMIN_PASSWORD || "";

const staffCount = db.prepare("SELECT COUNT(*) AS n FROM staff").get().n;
if (staffCount === 0) {
  if (email && password && password.length >= 8) {
    db.prepare("INSERT INTO staff (name, email, password_hash, created_at) VALUES (?,?,?,?)").run(
      name,
      email,
      bcrypt.hashSync(password, 10),
      Date.now(),
    );
    console.log(`Seeded lecturer account ${email}`);
  } else {
    console.log(
      "No staff account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters) so the first lecturer can sign in.",
    );
  }
}

const courses = [
  ["CSC 215", "Algorithm for Bioinformatics", "200 Level", "Software Engineering"],
  ["CSC 101", "Introduction to Computer Science", "100 Level", "Software Engineering"],
  ["SWE 301", "Software Engineering Principles", "300 Level", "Software Engineering"],
];
const courseCount = db.prepare("SELECT COUNT(*) AS n FROM courses").get().n;
if (courseCount === 0) {
  const insert = db.prepare(
    "INSERT INTO courses (code, title, level, department, created_at) VALUES (?,?,?,?,?)",
  );
  for (const [code, title, level, department] of courses) {
    insert.run(code, title, level, department, Date.now());
  }
  console.log(`Seeded ${courses.length} courses`);
}

console.log(
  `Database ready: ${db.prepare("SELECT COUNT(*) AS n FROM staff").get().n} staff, ` +
    `${db.prepare("SELECT COUNT(*) AS n FROM students").get().n} students, ` +
    `${db.prepare("SELECT COUNT(*) AS n FROM courses").get().n} courses.`,
);
