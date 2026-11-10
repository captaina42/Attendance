# AttendSecure — integrated attendance system

Two existing projects now run as one system on a single Express + SQLite backend:

- **Lecturer dashboard** (`public/`) — the "Attendance Pro" staff UI, unchanged in design.
- **Student app** (`public/student/`) — the "AttendSecure" student UI, unchanged in design.

Both talk to the same API and the same database (`data/attendance.db`). The lecturer
controls the life of every attendance session; students can only see and use sessions
that are currently ACTIVE.

## Run it

```bash
npm install
npm run migrate   # imports your existing accounts + demo class (safe to re-run)
PORT=3000 npm start
```

- Lecturers: <http://localhost:3000> (login page)
- Students: <http://localhost:3000/student/>

Use `http://localhost` rather than the LAN IP: fingerprint (WebAuthn) and the camera
need a secure context.

## Accounts carried over

| Who | Login | Password |
| --- | --- | --- |
| Lecturer (from the staff project) | `chiagozieobi315@gmail.com` | unchanged |
| Student (from the student project) | `GOU/U25/SWE/10` | unchanged |
| Demo classmates (seeded) | `GOU/U25/SWE/11` … `14` | `Student@123` |

`npm run migrate` seeds three courses (CSC 215 / 200, CSC 101 / 100, SWE 301 / 300,
Software Engineering) and enrols every student whose level (and department) matches.

## The workflow

1. Lecturer signs in and opens **Create Session**: course, class, duration (30 s / 1 min / 2 min), code.
2. The session is saved as **PENDING** — it is invisible to students.
3. **Activate attendance** → **ACTIVE** with `expires_at = now + remaining`.
4. Students poll every 3 s; the session appears with course, code and live countdown.
5. The student verifies with the device fingerprint (WebAuthn), captures a live camera
   photo (no gallery input) and the app submits automatically.
6. The lecturer's live page shows submitted / not-submitted / flagged, refreshed every second.
7. **Close session** → **CLOSED**; students immediately get "Attendance Session Closed".

Statuses: `PENDING`, `ACTIVE`, `CLOSED`, `EXPIRED`. An ACTIVE session past its expiry is
persisted as `EXPIRED` by the next request that touches it. **Pause attendance**
(deactivate) returns an ACTIVE session to PENDING while keeping the time left.

## Database (shared)

`staff`, `students`, `courses`, `enrollments`, `attendance_sessions`,
`attendance_records`, `verification_logs`, `flagged_submissions`.

A session stores its unique id, code, `course_id`, `staff_id`, level, duration, remaining
seconds, status, `created_at`, `activated_at`, `expires_at` and `closed_at`. A record is
unique per `(session_id, student_id)` and keeps the photo path, a SHA-256 photo hash,
face/fingerprint flags, the submission time and a status.

## API

Lecturer (cookie `ap_token`, staff only):

- `POST /api/auth/register|login|logout`, `GET /api/auth/me`
- `GET /api/courses`, `POST /api/courses`
- `POST /api/sessions` (PENDING), `POST /api/sessions/code`, `GET /api/sessions`
- `GET /api/sessions/:idOrCode`, `GET /api/sessions/:id/report`
- `POST /api/sessions/:id/activate|deactivate|close`
- `GET /api/records`, `GET /api/records/flagged`, `PATCH /api/records/:id`
- `POST /api/checkin` (legacy code-only page; always recorded as flagged)

Student (cookie `ap_student`):

- `POST /api/student/register|login|logout`, `GET /api/student/me`
- `GET /api/student/sessions` — ACTIVE sessions for the student's class only
- `GET /api/student/session/:code` — 409 while PENDING, 410 once closed/expired
- `POST /api/student/biometric/challenge|verify` — WebAuthn fingerprint
- `POST /api/student/attendance` — live photo + code, auto-submits
- `GET /api/student/history`

## Security

- Sessions are created, activated, paused and closed only by an authenticated lecturer,
  and only for sessions that lecturer owns.
- Every student endpoint re-checks the session status server-side, so a stale page cannot
  submit after close or expiry; duplicate submissions are rejected by a unique constraint.
- Photos live in `private_uploads/` and are never served as static files; the API returns
  no other student's personal data.
- State-changing requests require a same-origin `Origin`/`Referer`; login routes are
  rate-limited; passwords are bcrypt hashes; auth cookies are `HttpOnly` + `SameSite=Lax`.

## Flagging

Each submission stores a SHA-256 hash of the captured photo. If the same capture arrives
from a second student in the same session, that record is saved as `flagged` and a row is
written to `flagged_submissions` with the reason, for review on the **Flagged Students**
page. A submission without a fresh fingerprint check is stored as `pending` for follow-up.

## Test

With the server running on port 3000:

```bash
npm run test:e2e
```

It signs a lecturer in, creates a session, proves it is hidden while PENDING, activates it,
signs students in, verifies a fingerprint, submits (and blocks a duplicate), checks the
lecturer report and duplicate-face flag, closes the session and confirms late submissions
are refused with "Attendance session closed."

## Notes

- Node 22.13+ is required (`node:sqlite`).
- `PORT` defaults to 3000; set `PORT=3000` explicitly if your shell exports `PORT`.
- The original projects were left untouched; this folder is the merged system.

## Installable app (PWA)

The same app is installable on Android and desktop.

- `public/manifest.webmanifest` — name **AttendanceSecure**, `display: standalone`,
  `#11163f` theme/background, 192px, 512px and maskable 512px icons, plus shortcuts.
- `public/sw.js` — caches only the static shell. Anything under `/api/` is never cached or
  replayed, so an attendance submission can never be queued offline and bypass the
  server's checks.
- `public/js/pwa.js` — registers the worker, shows **Install app** where the browser offers
  it, and warns when the device goes offline.
- `/` is the unified entry: one sign-in form that sends staff to `/dashboard.html` and
  students to `/student/`, driven by `POST /api/entry/login` (role decided on the server).

Icons are generated with `npm run icons` (no image libraries needed).

## Biometrics (WebAuthn passkeys)

1. `POST /api/student/biometric/challenge` returns real registration or authentication
   options for the current student.
2. The phone creates or uses a passkey in the platform authenticator (fingerprint, face or
   device PIN). The private key stays on the device.
3. `POST /api/student/biometric/verify` verifies the attestation/signature on the server
   with `@simplewebauthn/server`: challenge, origin, RP ID, user-verification flag, counter
   and signature against the stored public key.
4. The verified assertion unlocks a 5-minute window; `POST /api/student/attendance` inside
   that window is stored as `verified`, otherwise `pending`.
5. `DELETE /api/student/biometric/credential` lets a student re-enrol from a new phone.

A fingerprint icon, a PIN field or a fake animation is never treated as verification: only
a signature that validates server-side counts.

## Deploy

See [DEPLOY.md](DEPLOY.md). `render.yaml` deploys the service with a 1 GB disk; `Dockerfile`
covers any other host. Required: `APP_ORIGIN` (https), `JWT_SECRET`, `DATA_DIR`.
