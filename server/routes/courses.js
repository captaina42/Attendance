// Courses a lecturer can open attendance sessions for.
const express = require("express");
const { db, LEVELS } = require("../db");
const { requireStaff, sameOrigin } = require("../middleware/auth");
const { syncEnrollments } = require("../lib/sessions");

const router = express.Router();
router.use(requireStaff);

function listCourses() {
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS students
       FROM courses c
       ORDER BY c.code COLLATE NOCASE, c.level`,
    )
    .all()
    .map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title,
      level: c.level,
      department: c.department,
      students: c.students,
      label: `${c.code} - ${c.title}`,
    }));
}

router.get("/", (req, res) => {
  res.json({ courses: listCourses(), levels: LEVELS });
});

router.post("/", sameOrigin, (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const title = String(req.body?.title || "").trim();
  const level = String(req.body?.level || "").trim();
  const department = String(req.body?.department || "").trim();

  if (!code) return res.status(400).json({ error: "Course code is required." });
  if (!title) return res.status(400).json({ error: "Course title is required." });
  if (!LEVELS.includes(level)) return res.status(400).json({ error: "Choose a valid level." });

  const existing = db
    .prepare("SELECT * FROM courses WHERE code = ? COLLATE NOCASE AND level = ?")
    .get(code, level);

  let id;
  if (existing) {
    id = existing.id;
    db.prepare("UPDATE courses SET title = ?, department = ? WHERE id = ?").run(
      title,
      department,
      id,
    );
  } else {
    const info = db
      .prepare(
        "INSERT INTO courses (code, title, level, department, created_at) VALUES (?,?,?,?,?)",
      )
      .run(code, title, level, department, Date.now());
    id = Number(info.lastInsertRowid);
  }

  syncEnrollments(id);
  res.status(existing ? 200 : 201).json({ course: listCourses().find((c) => c.id === id) });
});

module.exports = router;
