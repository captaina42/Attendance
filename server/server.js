// AttendSecure - one server for the lecturer dashboard and the student app.
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { PORT, ROOT_DIR, TRUST_PROXY } = require("./config");
require("./db");

const app = express();
app.disable("x-powered-by");
// Behind a hosting proxy (HTTPS terminated upstream) this keeps req.protocol and the
// rate limiter's client IP correct, which also matters for the WebAuthn origin check.
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "8mb" }));
app.use(cookieParser());

// Used by the hosting platform's health check (and by you, to confirm the deploy is live).
app.get("/api/health", (req, res) => res.json({ ok: true, app: "AttendanceSecure" }));

app.use("/api/entry", require("./routes/entry"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/courses", require("./routes/courses"));
app.use("/api/sessions", require("./routes/sessions"));
app.use("/api/records", require("./routes/records"));
app.use("/api/checkin", require("./routes/checkin"));
app.use("/api/student", require("./routes/student"));

// Captured photos are private: never served as static files.
app.use("/private_uploads", (req, res) => res.status(404).json({ error: "Not found." }));

// The service worker must never be served from the HTTP cache, or updates never arrive.
app.get("/sw.js", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(ROOT_DIR, "public", "sw.js"));
});

app.use(
  express.static(path.join(ROOT_DIR, "public"), {
    index: "index.html",
    setHeaders(res, filePath) {
      if (/\.(html|webmanifest)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      else if (/\.(css|js|png)$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=3600");
    },
  }),
);
app.get("/student", (req, res) => res.redirect("/student/"));

app.use("/api", (req, res) => res.status(404).json({ error: "API route not found." }));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large")
    return res.status(413).json({ error: "That photo is too large." });
  if (err instanceof SyntaxError && "body" in err)
    return res.status(400).json({ error: "Invalid JSON body." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, () => {
  console.log(`AttendSecure staff dashboard: http://localhost:${PORT}`);
  console.log(`AttendSecure student app:     http://localhost:${PORT}/student/`);
});
