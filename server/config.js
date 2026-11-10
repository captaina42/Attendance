// Central configuration. One database and one photo folder for the whole system.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rootDir = path.join(__dirname, "..");

// When DATA_DIR is set (a mounted volume in production) all writable state lives there,
// so a redeploy never loses the database or the captured photos.
const dataRoot = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : rootDir;
const dataDir = path.join(dataRoot, "data");
const uploadDir = path.join(dataRoot, "private_uploads");
const photoDir = path.join(uploadDir, "photos");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(photoDir, { recursive: true });

// The JWT secret is generated once and stored in data/jwt.secret so logins survive restarts.
// Override with the JWT_SECRET environment variable in production.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, "jwt.secret");
  if (!fs.existsSync(file))
    fs.writeFileSync(file, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
}

// The public origin the app is served from, e.g. https://attendsecure.example.com.
// Passkey registration is bound to this host, so it must be set for a deployed instance.
const appOrigin = (process.env.APP_ORIGIN || "").replace(/\/+$/, "");

const httpsOrigin = appOrigin.startsWith("https://");

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  ROOT_DIR: rootDir,
  DATA_DIR: dataDir,
  DB_FILE: path.join(dataDir, "attendance.db"),
  UPLOAD_DIR: uploadDir,
  PHOTO_DIR: photoDir,
  JWT_SECRET: loadSecret(),
  APP_ORIGIN: appOrigin,
  // Relying Party ID for WebAuthn: the hostname only, never a URL or a port.
  RP_ID: process.env.RP_ID || (appOrigin ? new URL(appOrigin).hostname : ""),
  RP_NAME: process.env.RP_NAME || "AttendanceSecure",
  TRUST_PROXY: process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true",
  COOKIE_SECURE: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "1" || process.env.COOKIE_SECURE === "true"
    : process.env.NODE_ENV === "production" || httpsOrigin,
  TOKEN_TTL_SECONDS: 60 * 60 * 8,
  BIOMETRIC_FRESHNESS_MS: 5 * 60 * 1000,
};
