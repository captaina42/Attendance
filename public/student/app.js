const $ = (id) => document.getElementById(id);
const state = {
  mode: "login",
  student: null,
  session: null,
  timer: null,
  stream: null,
  facing: "user",
  record: null,
  records: [],
  sessions: [],
  biometricAvailable: null,
  sessionClosed: false,
  poller: null,
};

// The lecturer can close or pause a session at any moment; the app has to follow immediately.
function markSessionClosed(text = "Attendance Session Closed") {
  state.sessionClosed = true;
  if ($("sessionTimerNote")) $("sessionTimerNote").textContent = text;
  if ($("startVerification")) $("startVerification").disabled = true;
  msg("attendanceMessage", text);
}

/* ---------------- helpers ---------------- */
function msg(id, text, success = false) {
  $(id).textContent = text || "";
  $(id).classList.toggle("success", success);
}
const safe = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDate = (ts) => new Date(ts).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
const fmtDateTime = (ts) => `${fmtDate(ts)} · ${fmtTime(ts)}`;
function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

/* ---------------- login / register ---------------- */
function setMode(value) {
  state.mode = value;
  $("loginTab").classList.toggle("active", value === "login");
  $("registerTab").classList.toggle("active", value === "register");
  ["nameField", "studentField", "emailField", "departmentField", "levelField"].forEach((id) =>
    $(id).classList.toggle("hidden", value !== "register")
  );
  $("identifierWrap").classList.toggle("hidden", value === "register");
  // A hidden required field blocks submit silently, so only require it while logging in.
  $("identifier").required = value === "login";
  $("formTitle").textContent = value === "login" ? "Welcome back" : "Create your account";
  $("formSubtitle").textContent =
    value === "login" ? "Enter your details to continue." : "Register with your student details.";
  $("submitButton").textContent = value === "login" ? "Log in" : "Create account";
  msg("message", "");
}
$("loginTab").onclick = () => setMode("login");
$("registerTab").onclick = () => setMode("register");

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("submitButton");
  button.disabled = true;
  msg("message", "");
  try {
    const body =
      state.mode === "register"
        ? {
            fullName: $("fullName").value,
            studentNumber: $("studentNumber").value,
            email: $("email").value,
            department: $("department").value,
            level: $("level").value,
            password: $("password").value,
          }
        : { identifier: $("identifier").value, password: $("password").value };
    await api(state.mode === "register" ? "/api/student/register" : "/api/student/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await loadApp();
  } catch (err) {
    msg("message", err.message);
  } finally {
    button.disabled = false;
  }
});

/* ---------------- app shell ---------------- */
async function loadApp() {
  const { student } = await api("/api/student/me");
  state.student = student;
  const initial = (student.fullName || "S").trim().charAt(0).toUpperCase();
  $("studentName").textContent = (student.fullName || "Student").split(" ")[0];
  $("avatar").textContent = initial;
  $("profileAvatar").textContent = initial;
  $("profileName").textContent = student.fullName;
  $("profileNumber").textContent = student.studentNumber;
  $("profileDepartment").textContent = student.department || "Not set";
  $("profileLevel").textContent = student.level || "Not set";
  $("profileEmail").textContent = student.email;
  $("profileBiometric").textContent = student.biometricEnrolled ? "Enrolled" : "Not enrolled";
  $("authView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  showScreen("home");
  await refreshAll();
  if (!state.poller) state.poller = setInterval(poll, 3000);
}

// Keeps the student view in step with the lecturer without a page refresh.
async function poll() {
  try {
    await refreshAll();
    if (state.session && !state.sessionClosed) {
      const stillLive = state.sessions.some((s) => s.code === state.session.code);
      if (!stillLive) markSessionClosed("Attendance Session Closed");
    }
  } catch {
    /* the next tick tries again */
  }
}

function showScreen(name) {
  ["home", "classes", "profile"].forEach((s) => $(`screen-${s}`).classList.toggle("hidden", s !== name));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.screen === name));
  document.querySelector(".app-body").scrollTop = 0;
}
document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => showScreen(b.dataset.screen)));

async function refreshAll() {
  await Promise.all([loadHome(), loadClasses()]);
}

async function loadHome() {
  const [{ sessions }, { records }] = await Promise.all([api("/api/student/sessions"), api("/api/student/history")]);
  state.sessions = sessions;
  state.records = records;
  $("recordCount").textContent = records.length;
  $("verifiedCount").textContent = records.filter((r) => r.status === "verified").length;
  $("sessionsList").innerHTML = sessions.length
    ? sessions.map(sessionCard).join("")
    : '<div class="empty">No active sessions at the moment.</div>';
  $("sessionsList").querySelectorAll("[data-code]").forEach((el) => {
    el.onclick = () => startSession(el.dataset.code);
  });
}

function sessionCard(s) {
  return `<div class="item" data-code="${safe(s.code)}">
    <div class="grow"><b>${safe(s.course)}</b><small>${safe(s.level)} · ${safe(s.code)} · ends ${fmtTime(s.endsAt)}</small></div>
    <span class="tag ${s.submitted ? "done" : ""}">${s.submitted ? "Submitted" : "Active"}</span>
  </div>`;
}

async function loadClasses() {
  const [{ sessions }, { records }] = await Promise.all([api("/api/student/sessions"), api("/api/student/history")]);
  state.sessions = sessions;
  state.records = records;
  $("classesActive").innerHTML = sessions.length
    ? sessions.map(sessionCard).join("")
    : '<div class="empty">No active sessions right now.</div>';
  $("classesActive").querySelectorAll("[data-code]").forEach((el) => {
    el.onclick = () => startSession(el.dataset.code);
  });
  $("historyList").innerHTML = records.length
    ? records
        .map(
          (r, i) => `<div class="item" data-record="${i}">
      <div class="grow"><b>${safe(r.course)}</b><small>${safe(r.level)} · ${fmtDateTime(r.markedAt)}</small></div>
      <span class="tag ${r.status === "verified" ? "" : "pending"}">${r.status === "verified" ? "Verified" : "Pending"}</span>
    </div>`
        )
        .join("")
    : '<div class="empty">You have no attendance records yet.</div>';
  $("historyList").querySelectorAll("[data-record]").forEach((el) => {
    el.onclick = () => showStatus(state.records[Number(el.dataset.record)]);
  });
}

/* ---------------- step 1: session + countdown ---------------- */
const overlays = Array.from(document.querySelectorAll(".overlay"));
function showOverlay(id) {
  overlays.forEach((o) => o.classList.toggle("hidden", o.id !== id));
  $(id).scrollTop = 0;
}
function closeOverlays() {
  overlays.forEach((o) => o.classList.add("hidden"));
  stopCountdown();
  stopCamera();
}
document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = closeOverlays));

async function startSession(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  msg("attendanceMessage", "");
  msg("message", "");
  if (!code) return msg("attendanceMessage", "Enter the attendance code from your lecturer.");
  try {
    const data = await api(`/api/student/session/${encodeURIComponent(code)}`);
    if (data.submitted) {
      const record = state.records.find((r) => String(r.code).toUpperCase() === code);
      if (record) return showStatus(record);
      return msg("attendanceMessage", "You have already submitted attendance for this session.");
    }
    state.session = data.session;
    $("attendanceCode").value = "";
    openSessionScreen();
  } catch (err) {
    msg("attendanceMessage", /closed/i.test(err.message) ? "Attendance Session Closed" : err.message);
  }
}

function openSessionScreen() {
  state.sessionClosed = false;
  $("startVerification").disabled = false;
  const s = state.session;
  $("sessionCourse").textContent = s.course;
  $("sessionLecturer").textContent = s.lecturer || "Not listed";
  $("sessionLevel").textContent = s.level;
  $("sessionTime").textContent = `${fmtTime(s.startsAt)} – ${fmtTime(s.endsAt)}`;
  $("sessionTimerNote").textContent = "Please do not refresh this page, your attendance will be lost.";
  showOverlay("sessionScreen");
  startCountdown();
}

function startCountdown() {
  stopCountdown();
  const total = Math.max(1000, state.session.endsAt - state.session.startsAt);
  const circumference = 2 * Math.PI * 54;
  const tick = () => {
    const remaining = Math.max(0, state.session.endsAt - Date.now());
    $("countdownText").textContent = fmtClock(remaining);
    $("countdownRing").style.strokeDashoffset = String(circumference * (1 - Math.min(1, remaining / total)));
    if (remaining === 0) {
      stopCountdown();
      markSessionClosed("Attendance Session Closed");
    }
  };
  tick();
  state.timer = setInterval(tick, 1000);
}
function stopCountdown() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

$("attendanceForm").addEventListener("submit", (e) => {
  e.preventDefault();
  startSession($("attendanceCode").value);
});

/* ---------------- step 2: biometric (WebAuthn passkey) ---------------- */
$("startVerification").onclick = () => openFingerprint();

async function platformAvailable() {
  if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
  }
  return false;
}

async function openFingerprint() {
  msg("fingerMessage", "");
  showOverlay("fingerScreen");
  if (state.biometricAvailable === null) state.biometricAvailable = await platformAvailable();
  const enrolled = Boolean(state.student && state.student.biometricEnrolled);
  if (state.biometricAvailable) {
    $("fingerHint").textContent = enrolled
      ? "Use your fingerprint or face unlock to confirm it is you."
      : "Your device will ask once to create a passkey for AttendSecure, protected by your fingerprint or face.";
    $("fingerButton").dataset.skip = "";
    $("fingerButton").disabled = false;
  } else {
    $("fingerHint").textContent =
      "This device has no fingerprint or face unlock available here, so it cannot verify you. You can still continue — your attendance will be marked pending and your lecturer is told why.";
    $("fingerButton").dataset.skip = "1";
  }
}

$("fingerButton").onclick = async () => {
  if ($("fingerButton").dataset.skip === "1") return openCamera();
  $("fingerButton").disabled = true;
  msg("fingerMessage", "Waiting for your fingerprint or face…");
  try {
    const start = await api("/api/student/biometric/challenge", { method: "POST", body: "{}" });
    const publicKey = buildRequestOptions(start.mode, start.options);
    const credential =
      start.mode === "register"
        ? await navigator.credentials.create({ publicKey })
        : await navigator.credentials.get({ publicKey });
    if (!credential) throw new Error("Biometric verification was cancelled.");
    await api("/api/student/biometric/verify", {
      method: "POST",
      body: JSON.stringify({ mode: start.mode, credential: serializeCredential(start.mode, credential) }),
    });
    if (state.student) state.student.biometricEnrolled = true;
    msg("fingerMessage", "Identity verified.", true);
    openCamera();
  } catch (err) {
    const name = err && err.name;
    const text =
      name === "NotAllowedError"
        ? "Biometric check was cancelled. Tap again to retry."
        : name === "InvalidStateError"
        ? "This device is already set up for your account. If the prompt does not appear, reset biometrics from your Profile and try again."
        : name === "SecurityError"
        ? "Biometrics need a secure (https) connection. Open the app over https and try again."
        : err.message || "Biometric verification failed.";
    msg("fingerMessage", text);
  } finally {
    $("fingerButton").disabled = false;
  }
};

// Turn the server's JSON options into the ArrayBuffers the browser API expects.
function buildRequestOptions(mode, options) {
  const bytes = b64urlToBytes;
  if (mode === "register") {
    return {
      challenge: bytes(options.challenge),
      rp: options.rp,
      user: { ...options.user, id: bytes(options.user.id) },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation || "none",
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })),
    };
  }
  return {
    challenge: bytes(options.challenge),
    rpId: options.rpId,
    timeout: options.timeout,
    userVerification: options.userVerification || "required",
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })),
  };
}

// The server needs the raw bytes to check the signature, so everything is base64url encoded.
function serializeCredential(mode, credential) {
  const enc = (buf) => (buf ? bytesToB64url(new Uint8Array(buf)) : null);
  const base = {
    id: credential.id,
    rawId: enc(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
  };
  if (mode === "register") {
    return {
      ...base,
      authenticatorAttachment: credential.authenticatorAttachment || "platform",
      response: {
        clientDataJSON: enc(credential.response.clientDataJSON),
        attestationObject: enc(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : ["internal"],
      },
    };
  }
  return {
    ...base,
    response: {
      clientDataJSON: enc(credential.response.clientDataJSON),
      authenticatorData: enc(credential.response.authenticatorData),
      signature: enc(credential.response.signature),
      userHandle: enc(credential.response.userHandle),
    },
  };
}

function b64urlToBytes(value) {
  const b64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64url(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------------- step 3: camera ---------------- */
async function openCamera() {
  msg("cameraMessage", "");
  showOverlay("cameraScreen");
  await startCamera();
}

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    msg("cameraMessage", "Camera is unavailable here. Open the app over https:// or on http://localhost.");
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing, width: { ideal: 720 }, height: { ideal: 960 } },
      audio: false,
    });
    $("video").srcObject = state.stream;
    await $("video").play().catch(() => {});
  } catch (err) {
    const text =
      err.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access for this site and try again."
        : err.name === "NotFoundError"
        ? "No camera was found on this device."
        : `Could not start the camera: ${err.message}`;
    msg("cameraMessage", text);
  }
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  const video = $("video");
  if (video) video.srcObject = null;
}

$("flipButton").onclick = async () => {
  state.facing = state.facing === "user" ? "environment" : "user";
  $("video").style.transform = state.facing === "user" ? "scaleX(-1)" : "none";
  await startCamera();
};

$("captureButton").onclick = async () => {
  const video = $("video");
  if (!state.stream || !video.videoWidth) {
    msg("cameraMessage", "The camera is not ready yet. Wait a moment and capture again.");
    return;
  }
  const button = $("captureButton");
  button.disabled = true;
  msg("cameraMessage", "");
  try {
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = Math.max(0, (video.videoHeight - side) / 4);
    const canvas = $("canvas");
    const size = 640;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (state.facing === "user") {
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
    const photo = canvas.toDataURL("image/jpeg", 0.72);
    const result = await api("/api/student/attendance", {
      method: "POST",
      body: JSON.stringify({ code: state.session.code, photo }),
    });
    stopCamera();
    stopCountdown();
    showSuccess(result.record);
    refreshAll().catch(() => {});
  } catch (err) {
    if (/closed|not been activated|invalid or not active/i.test(err.message)) {
      stopCamera();
      stopCountdown();
      closeOverlays();
      markSessionClosed(/not been activated/i.test(err.message) ? err.message : "Attendance Session Closed");
      refreshAll().catch(() => {});
      return;
    }
    msg("cameraMessage", err.message);
  } finally {
    button.disabled = false;
  }
};

/* ---------------- step 4 & 5: confirmation ---------------- */
function showSuccess(record) {
  state.record = record;
  const verified = record.status === "verified";
  $("successCourse").textContent = record.course;
  $("successCode").textContent = record.code;
  $("successStudent").textContent = state.student.studentNumber;
  $("successTime").textContent = fmtDateTime(record.markedAt);
  $("successNote").textContent = verified
    ? "Your attendance is recorded and verified."
    : "Your attendance has been recorded. Verification is in progress.";
  $("successPill").textContent = verified ? "Verified Successfully" : "Submitted Successfully";
  showOverlay("successScreen");
}

function showStatus(record) {
  if (!record) return;
  state.record = record;
  const verified = record.status === "verified";
  $("statusCourse").textContent = record.course;
  $("statusMeta").textContent = `${record.level} · ${fmtDate(record.markedAt)} · ${fmtTime(record.markedAt)}`;
  $("statusFace").textContent = record.faceVerified ? "Captured" : "Not captured";
  $("statusFinger").textContent = record.fingerprintVerified ? "Verified" : "Pending";
  $("statusBadge").textContent = verified ? "Verified" : "Pending verification";
  $("statusBadge").classList.toggle("ok", verified);
  $("statusNote").textContent = verified
    ? "Your photo and fingerprint were verified for this session."
    : "Your photo is safely stored. Fingerprint verification is still in progress for this record.";
  showOverlay("statusScreen");
}

$("successStatus").onclick = () => showStatus(state.record);
$("successHome").onclick = () => {
  closeOverlays();
  showScreen("home");
  refreshAll().catch(() => {});
};
$("statusHome").onclick = () => {
  closeOverlays();
  showScreen("home");
  refreshAll().catch(() => {});
};

/* ---------------- logout + boot ---------------- */
$("logoutButton").onclick = async () => {
  await api("/api/student/logout", { method: "POST" }).catch(() => {});
  closeOverlays();
  state.student = null;
  state.records = [];
  state.sessions = [];
  $("appView").classList.add("hidden");
  $("authView").classList.remove("hidden");
  $("authForm").reset();
  setMode("login");
};

// Remove the passkey from this account so a new phone can enrol with a new fingerprint.
$("resetBiometric").onclick = async () => {
  if (!confirm("Remove the passkey stored for your account? You will enrol again on your next check-in."))
    return;
  try {
    await api("/api/student/biometric/credential", { method: "DELETE" });
    if (state.student) state.student.biometricEnrolled = false;
    $("profileBiometric").textContent = "Not enrolled";
    state.biometricAvailable = null;
    alert("Passkey removed. Your next check-in will set up this device again.");
  } catch (err) {
    alert(err.message);
  }
};

setMode("login");
loadApp().catch(() => {
  $("appView").classList.add("hidden");
  $("authView").classList.remove("hidden");
});
