// End-to-end check of the 9-step workflow against a running server.
// Usage: node scripts/e2e-test.js   (server must be on http://localhost:3000)
const BASE = process.env.BASE || "http://localhost:3000";

function client() {
  const jar = new Map();
  return async function call(method, path, body) {
    const headers = { Origin: BASE };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (!value) jar.delete(name);
      else jar.set(name, value);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data };
  };
}

const photo = (seed) =>
  "data:image/jpeg;base64," + Buffer.alloc(4096, seed).toString("base64");

let failures = 0;
function check(label, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  -> ${extra}` : ""}`);
  if (!ok) failures++;
}

async function asStaff() {
  const staff = client();
  let r = await staff("POST", "/api/auth/register", {
    name: "E2E Lecturer",
    email: "e2e.lecturer@test.local",
    password: "TestPass123",
  });
  if (r.status === 409)
    r = await staff("POST", "/api/auth/login", {
      email: "e2e.lecturer@test.local",
      password: "TestPass123",
    });
  return { staff, user: r.data?.user, login: r.status };
}

async function asStudent(number) {
  const student = client();
  const r = await student("POST", "/api/student/login", {
    identifier: number,
    password: "Student@123",
  });
  return { student, status: r.status, me: r.data?.student };
}

const { VirtualAuthenticator } = require("./virtual-authenticator");

const origin = BASE;
const rpId = new URL(BASE).hostname;

// A real platform-authenticator dance: enrol on first use, then sign a fresh challenge.
async function biometric(student) {
  const authenticator = new VirtualAuthenticator({ rpId, origin });
  let ch = await student("POST", "/api/student/biometric/challenge");
  if (ch.status !== 200) return ch;

  // A passkey from a previous run lives on a key we no longer hold, so re-enrol first.
  if (ch.data.mode === "authenticate") {
    await student("DELETE", "/api/student/biometric/credential");
    ch = await student("POST", "/api/student/biometric/challenge");
    if (ch.status !== 200) return ch;
  }

  const mode = ch.data.mode;
  const credential =
    mode === "register" ? authenticator.register(ch.data.options) : authenticator.assert(ch.data.options);
  const verified = await student("POST", "/api/student/biometric/verify", { mode, credential });

  // A response signed by a different key (or a mangled signature) must be refused.
  const ch2 = await student("POST", "/api/student/biometric/challenge");
  const forged = authenticator.assert(ch2.data.options);
  forged.response.signature = Buffer.alloc(70, 7).toString("base64url");
  const rejected = await student("POST", "/api/student/biometric/verify", {
    mode: ch2.data.mode,
    credential: forged,
  });

  // A challenge replayed after it was used must be refused too.
  const replay = await student("POST", "/api/student/biometric/verify", { mode, credential });

  return { ...verified, forgedStatus: rejected.status, forgedData: rejected.data, replayStatus: replay.status };
}

async function main() {
  // 1. Lecturer signs in.
  const { staff, user, login } = await asStaff();
  check("1. lecturer authenticated", login === 201 || login === 200, `status ${login}, ${user?.email}`);

  const courses = await staff("GET", "/api/courses");
  const course = (courses.data?.courses || []).find((c) => c.code === "CSC 215");
  check("   course list available", Boolean(course), course?.code);

  // 2. Create a session -> PENDING.
  const code = "T" + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[IO01]/g, "A");
  const created = await staff("POST", "/api/sessions", {
    courseId: course?.id,
    level: "200 Level",
    duration: 30,
    code,
  });
  const id = created.data?.session?.id;
  check(
    "2. session created as PENDING",
    created.status === 201 && created.data?.session?.status === "PENDING",
    `code ${code}, id ${id}, ${created.data?.session?.status}`,
  );

  // 3. Students cannot see or open it while PENDING.
  const a = await asStudent("GOU/U25/SWE/11");
  check("   student signed in", a.status === 200, a.me?.fullName);
  const hidden = await a.student("GET", "/api/student/sessions");
  check(
    "3. PENDING session hidden from student",
    !(hidden.data?.sessions || []).some((s) => s.code === code),
  );
  const early = await a.student("GET", `/api/student/session/${code}`);
  check("   PENDING session rejected by code", early.status === 409, early.data?.error);

  // 4. Lecturer activates it.
  const activated = await staff("POST", `/api/sessions/${id}/activate`);
  check(
    "4. session ACTIVE with countdown",
    activated.status === 200 &&
      activated.data?.session?.status === "ACTIVE" &&
      activated.data.session.secondsLeft > 0,
    `${activated.data?.session?.status}, ${activated.data?.session?.secondsLeft}s left`,
  );

  // 5. Student receives it immediately.
  const visible = await a.student("GET", "/api/student/sessions");
  const live = (visible.data?.sessions || []).find((s) => s.code === code);
  check("5. ACTIVE session visible to student", Boolean(live), live ? `ends in ${live.secondsLeft}s` : "");
  const detail = await a.student("GET", `/api/student/session/${code}`);
  check("   session details by code", detail.status === 200, detail.data?.session?.course);

  // 6. Verify identity, then submit.
  const bio = await biometric(a.student);
  check("6a. passkey enrolled + signed assertion verified", bio.status === 200, JSON.stringify(bio.data));
  check("   forged signature rejected", bio.forgedStatus === 401, bio.forgedData?.error);
  check(
    "   replayed challenge rejected",
    [400, 401, 409].includes(bio.replayStatus),
    `status ${bio.replayStatus}`,
  );
  const submit = await a.student("POST", "/api/student/attendance", {
    code,
    photo: photo("a"),
  });
  check(
    "6b. attendance submitted as verified",
    submit.status === 201 && submit.data?.record?.status === "verified",
    `${submit.status} ${submit.data?.record?.status}`,
  );

  const again = await a.student("POST", "/api/student/attendance", { code, photo: photo("b") });
  check("   duplicate submission blocked", again.status === 409, again.data?.error);

  // 7. Lecturer sees the submission.
  const rep = await staff("GET", `/api/sessions/${id}/report`);
  check(
    "7. lecturer sees submission",
    rep.data?.counts?.submitted === 1,
    `submitted ${rep.data?.counts?.submitted}, absent ${rep.data?.counts?.absent}`,
  );

  // Duplicate face from another student is flagged for review.
  const b = await asStudent("GOU/U25/SWE/12");
  await biometric(b.student);
  const twin = await b.student("POST", "/api/student/attendance", { code, photo: photo("a") });
  const rep2 = await staff("GET", `/api/sessions/${id}/report`);
  check(
    "   duplicate face flagged",
    twin.status === 201 && twin.data?.record?.status === "flagged" && rep2.data?.counts?.flagged === 1,
    `${twin.data?.record?.status}, flagged ${rep2.data?.counts?.flagged}`,
  );

  // 8. Lecturer closes the session.
  const closed = await staff("POST", `/api/sessions/${id}/close`);
  check("8. session CLOSED", closed.data?.session?.status === "CLOSED", closed.data?.session?.status);

  // 9. Students are blocked afterwards.
  const c = await asStudent("GOU/U25/SWE/13");
  await biometric(c.student);
  const late = await c.student("POST", "/api/student/attendance", { code, photo: photo("c") });
  check(
    "9. submission blocked after close",
    late.status === 410 && /closed/i.test(late.data?.error || ""),
    late.data?.error,
  );
  const gone = await c.student("GET", `/api/student/session/${code}`);
  check("   student sees session closed", gone.status === 410, gone.data?.error);
  const stillHidden = await c.student("GET", "/api/student/sessions");
  check("   closed session disappears from list", !(stillHidden.data?.sessions || []).some((s) => s.code === code));

  // Security spot checks.
  const anon = client();
  check("   session creation requires staff", (await anon("POST", "/api/sessions", {})).status === 401);
  const studentCreate = await a.student("POST", "/api/sessions", { course: "CSC 215", duration: 30 });
  check("   students cannot create sessions", studentCreate.status === 401 || studentCreate.status === 403);

  // Installable app: manifest, icons and a service worker that never caches API data.
  const manifestRes = await fetch(BASE + "/manifest.webmanifest");
  const manifest = await manifestRes.json().catch(() => ({}));
  check(
    "   PWA manifest is installable",
    manifestRes.status === 200 &&
      manifest.name === "AttendanceSecure" &&
      manifest.display === "standalone" &&
      (manifest.icons || []).length >= 3,
    `${manifest.display}, ${(manifest.icons || []).length} icons`,
  );
  const icon512 = await fetch(BASE + "/icons/icon-512.png");
  const icon192 = await fetch(BASE + "/icons/icon-192.png");
  check(
    "   192px and 512px icons served",
    icon512.status === 200 &&
      icon192.status === 200 &&
      icon512.headers.get("content-type") === "image/png",
  );
  const swRes = await fetch(BASE + "/sw.js");
  const swText = await swRes.text();
  check(
    "   service worker served, uncached, API excluded",
    swRes.status === 200 &&
      /no-cache/.test(swRes.headers.get("cache-control") || "") &&
      /isApi\(url\)\) return;/.test(swText) &&
      /request.method !== "GET"/.test(swText),
    swRes.headers.get("cache-control"),
  );
  check("   health endpoint", (await fetch(BASE + "/api/health")).status === 200);

  // One sign-in, routed by role, with the two audiences kept apart.
  const anonEntry = client();
  const unknown = await anonEntry("POST", "/api/entry/login", {
    identifier: "nobody@test.local",
    password: "whatever123",
  });
  check("   entry rejects unknown account", unknown.status === 401);

  const staffEntry = client();
  const se = await staffEntry("POST", "/api/entry/login", {
    identifier: "e2e.lecturer@test.local",
    password: "TestPass123",
  });
  check(
    "   entry sends staff to the staff dashboard",
    se.status === 200 && se.data?.role === "staff",
    se.data?.redirect,
  );

  const studentEntry = client();
  const ste = await studentEntry("POST", "/api/entry/login", {
    identifier: "GOU/U25/SWE/11",
    password: "Student@123",
  });
  check(
    "   entry sends student to the student app",
    ste.status === 200 && ste.data?.role === "student",
    ste.data?.redirect,
  );
  check(
    "   student session cannot read staff endpoints",
    (await studentEntry("GET", "/api/records")).status === 401,
  );
  check(
    "   student session cannot create sessions",
    (await studentEntry("POST", "/api/sessions", { course: "CSC 215", duration: 30 })).status === 401,
  );

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
