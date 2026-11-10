/**
 * Attendance Pro - front-end script
 *
 * All data comes from the server through the JSON API under /api.
 * Each page sets <body data-page="..." data-auth>, which decides what runs below.
 */

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const empty = (cols, msg) => `<tr><td colspan="${cols}" class="empty">${msg}</td></tr>`;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

const badge = (status) =>
  status === "flagged" ? '<span class="b r">Flagged</span>' : '<span class="b g">Present</span>';

/** Table rows for attendance records. `withAction` adds a Flag / Clear flag button column. */
function recordRows(list, emptyMsg, withAction) {
  if (!list.length) return empty(withAction ? 7 : 6, emptyMsg);
  return list
    .map((r, i) => {
      const action = withAction
        ? `<td><button class="btn ghost sm" data-flag="${r.status === "flagged" ? "present" : "flagged"}" data-id="${r.id}">${
            r.status === "flagged" ? "Clear flag" : "Flag"
          }</button></td>`
        : "";
      return `<tr><td>${i + 1}</td><td>${esc(r.studentId)}</td><td>${esc(r.name)}</td><td>${esc(r.course)}</td>
        <td>${fmt(r.markedAt)}</td><td>${badge(r.status)}</td>${action}</tr>`;
    })
    .join("");
}

// ----------------------------------------------------------------------------
// Pages
// ----------------------------------------------------------------------------
const pages = {
  // Lecturer: dashboard
  async dashboard() {
    const [{ sessions }, { records }] = await Promise.all([api("/sessions"), api("/records")]);
    $("#s1").textContent = sessions.length;
    $("#s2").textContent = records.length;
    $("#s3").textContent = new Set(records.map((r) => r.studentId)).size;
    $("#s4").textContent = records.filter((r) => r.status === "flagged").length;
    $("#cls").innerHTML = sessions.length
      ? sessions
          .map(
            (s) => `<div class="cls"><div><b>${esc(s.course)}</b>
              <span class="sub">${esc(s.level)} · Code ${s.code} · ${s.count} present</span></div>
              <a href="live.html?code=${s.code}" class="b ${{ ACTIVE: "g", PENDING: "bl", CLOSED: "r", EXPIRED: "r" }[s.status] || "bl"}">${
                s.status.charAt(0) + s.status.slice(1).toLowerCase()
              }</a></div>`,
          )
          .join("")
      : '<p class="empty">No sessions yet.<br><br><a class="btn sm" href="create-session.html">Create your first session</a></p>';
  },

  // Lecturer: create session
  "create-session"() {
    const codeInput = $("#sc");
    const showCode = () => {
      const code = codeInput.value.trim();
      $("#codeview").textContent = code || "------";
      $("#codemsg").textContent = code
        ? "Students enter this code on the check-in page to mark attendance."
        : "No code generated yet. You can generate one now, or one will be created when the session starts.";
    };
    const generate = async () => {
      try {
        const { code } = await api("/sessions/code", { method: "POST" });
        codeInput.value = code;
        showCode();
      } catch (err) {
        $("#codemsg").textContent = err.message;
      }
    };
    codeInput.oninput = () => {
      // No I or O, so students cannot confuse them with 1 and 0.
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
      showCode();
    };
    $("#gencode").onclick = generate;
    generate();
    // Courses already in the database are offered as suggestions; typing a new one still works.
    let courses = [];
    const matched = () => {
      const text = $("#co").value.trim().toLowerCase();
      return courses.find(
        (c) =>
          c.code.toLowerCase() === text ||
          `${c.code} - ${c.title}`.toLowerCase() === text ||
          c.title.toLowerCase() === text,
      );
    };
    api("/courses")
      .then(({ courses: list }) => {
        courses = list || [];
        $("#courselist").innerHTML = courses
          .map(
            (c) =>
              `<option value="${esc(c.code)}" label="${esc(c.code)} - ${esc(c.title)} (${esc(c.level)})"></option>`,
          )
          .join("");
      })
      .catch(() => {});
    $("#co").addEventListener("change", () => {
      const c = matched();
      if (c && c.level) $("#lv").value = c.level;
    });
    $("#cf").onsubmit = async (e) => {
      e.preventDefault();
      try {
        const course = matched();
        const { session } = await api("/sessions", {
          method: "POST",
          body: {
            courseId: course?.id,
            course: $("#co").value,
            level: $("#lv").value,
            duration: Number($("#du").value),
            code: codeInput.value.trim(),
          },
        });
        location.href = "live.html?code=" + session.code;
      } catch (err) {
        alert(err.message);
      }
    };
  },

  // Student: check in with the code shown by the lecturer
  checkin() {
    const code = $("#code");
    code.oninput = () => (code.value = code.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ""));
    code.value = (new URLSearchParams(location.search).get("code") || "").toUpperCase();
    $("#cf").onsubmit = async (e) => {
      e.preventDefault();
      $("#msg").textContent = "";
      try {
        const { session } = await api("/checkin", {
          method: "POST",
          body: { code: code.value, studentNumber: $("#sno").value, name: $("#snm").value },
        });
        $("#cf").outerHTML = `<div style="text-align:center;padding:10px 0">
          <span class="b g">Present</span>
          <h2 style="margin-top:14px">You are marked present</h2>
          <p class="sub">${esc(session.course)} · ${esc(session.level)}</p></div>`;
      } catch (err) {
        $("#msg").textContent = err.message;
      }
    };
  },

  // Lecturer: live attendance (polls the server every second)
  async live() {
    let code = new URLSearchParams(location.search).get("code");
    if (!code) code = (await api("/sessions")).sessions[0]?.code;
    if (!code) {
      $("#lv").innerHTML =
        '<p class="empty">No active session.<br><br><a class="btn sm" href="create-session.html">Create a session</a></p>';
      return;
    }
    const statusBadge = (s) => {
      const map = {
        ACTIVE: ["g", "Active"],
        PENDING: ["bl", "Pending"],
        CLOSED: ["r", "Closed"],
        EXPIRED: ["r", "Expired"],
      };
      const [cls, label] = map[s.status] || ["bl", s.status];
      return `<span class="b ${cls}">${label}</span>`;
    };
    const clock = (secs) => {
      const s = Math.max(0, secs || 0);
      return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };
    const rows = (list, msg, kind) => {
      if (!list.length) return `<tr><td colspan="4" class="empty">${msg}</td></tr>`;
      return list
        .map((r, i) => {
          const state =
            kind === "absent"
              ? '<span class="b bl">Not submitted</span>'
              : r.recordStatus === "flagged"
                ? '<span class="b r">Flagged</span>'
                : `<span class="b g">Present</span> <span class="sub">${r.submittedAt ? fmt(r.submittedAt) : ""}</span>`;
          return `<tr><td>${i + 1}</td><td>${esc(r.studentNumber || "")}</td><td>${esc(r.name)}</td><td>${state}</td></tr>`;
        })
        .join("");
    };

    let tab = "submitted";
    let id = null;
    let lastSig = "";
    const tabs = {
      submitted: (d) => rows(d.submitted, "Nobody has submitted yet.", "submitted"),
      absent: (d) => rows(d.absent, "Everyone on the roster has submitted.", "absent"),
      flagged: (d) => rows(d.flagged, "No suspicious submissions for this session.", "flagged"),
    };

    const draw = async () => {
      const d = await api("/sessions/" + code);
      const s = d.session;
      id = s.id;
      code = s.code;
      // Only the countdown changes every second; re-rendering the whole card would
      // swallow clicks on the control buttons.
      const sig = JSON.stringify([
        s.status,
        s.duration,
        s.course,
        s.code,
        s.level,
        d.counts,
        tab,
        d.submitted.map((r) => r.recordId),
        d.flagged.map((r) => r.flagId),
      ]);
      const timer = $("#lv .timer");
      if (sig === lastSig && timer) {
        timer.textContent = clock(s.secondsLeft);
        const bar = $("#lv .bar i");
        if (bar) bar.style.width = `${s.duration ? Math.min(100, (s.secondsLeft / s.duration) * 100) : 0}%`;
        return;
      }
      lastSig = sig;
      const tile = (n, label, cls) =>
        `<div class="n ${cls}"><span class="sub">${label}</span><b>${n}</b></div>`;
      const controls =
        s.status === "ACTIVE"
          ? `<button class="btn ghost sm" data-act="deactivate">Pause attendance</button>
             <button class="btn sm" data-act="close">Close session</button>`
          : s.status === "PENDING"
            ? `<button class="btn ok sm" data-act="activate">Activate attendance</button>
               <button class="btn ghost sm" data-act="close">Close session</button>`
            : `<span class="sub">This session is ${s.status.toLowerCase()}. Create a new one to run attendance again.</span>`;
      $("#lv").innerHTML = `
        <div class="live" style="margin-bottom:20px">
          <div><h2 style="margin:0 0 6px">${esc(s.course)}</h2>
            ${statusBadge(s)} <span class="sub">${esc(s.level)} · ${s.duration}s</span>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${controls}</div></div>
          <div><span class="sub">Student code</span><br><span class="codebox">${esc(s.code)}</span>
            <div><a class="sub" href="student/" target="_blank" rel="noopener">Student app</a></div></div>
          <div><span class="sub">Time left</span><div class="timer">${clock(s.secondsLeft)}</div>
            <div class="bar"><i style="width:${s.duration ? Math.min(100, (s.secondsLeft / s.duration) * 100) : 0}%"></i></div></div>
          ${tile(d.counts.submitted, "Present", "gr")}
          ${tile(d.counts.absent, "Not submitted", "bl")}
          ${tile(d.counts.flagged, "Flagged", "rd")}
        </div>
        <div class="tabs">
          <button class="tab ${tab === "submitted" ? "on" : ""}" data-tab="submitted">Submitted (${d.counts.submitted})</button>
          <button class="tab ${tab === "absent" ? "on" : ""}" data-tab="absent">Not submitted (${d.counts.absent})</button>
          <button class="tab ${tab === "flagged" ? "on" : ""}" data-tab="flagged">Flagged (${d.counts.flagged})</button>
        </div>
        <table><thead><tr><th>#</th><th>Student ID</th><th>Name</th><th>Status</th></tr></thead>
        <tbody>${tabs[tab](d)}</tbody></table>`;
    };

    $("#lv").addEventListener("click", async (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) {
        tab = t.dataset.tab;
        return draw().catch(() => {});
      }
      const b = e.target.closest("[data-act]");
      if (!b || !id) return;
      try {
        await api(`/sessions/${id}/${b.dataset.act}`, { method: "POST" });
        tab = "submitted";
        lastSig = "";
        await draw();
      } catch (err) {
        alert(err.message);
      }
    });

    await draw();
    setInterval(() => draw().catch(() => {}), 1000);
  },

  // Lecturer: attendance records with search and flagging
  async records() {
    let all = [];
    const draw = () => {
      const q = $("#q").value.toLowerCase();
      const list = all.filter((r) => (r.studentId + r.name + r.course).toLowerCase().includes(q));
      $("#rb").innerHTML = recordRows(list, "No attendance records yet.", true);
    };
    const load = async () => {
      all = (await api("/records")).records;
      draw();
    };
    $("#q").oninput = draw;
    document.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-flag]");
      if (!b) return;
      await api("/records/" + b.dataset.id, { method: "PATCH", body: { status: b.dataset.flag } });
      load();
    });
    await load();
  },

  // Lecturer: flagged students
  async flagged() {
    const load = async () => {
      const list = (await api("/records")).records.filter((r) => r.status === "flagged");
      $("#fb").innerHTML = list.length
        ? list
            .map(
              (
                r,
                i,
              ) => `<tr><td>${i + 1}</td><td>${esc(r.studentId)}</td><td>${esc(r.name)}</td><td>${esc(r.course)}</td>
              <td>${fmt(r.markedAt)}</td><td><button class="btn ok sm" data-flag="present" data-id="${r.id}">Mark as verified</button></td></tr>`,
            )
            .join("")
        : empty(6, "No flagged students. Flag a record from the Attendance Records page.");
    };
    document.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-flag]");
      if (!b) return;
      await api("/records/" + b.dataset.id, { method: "PATCH", body: { status: b.dataset.flag } });
      load();
    });
    await load();
  },

  // Lecturer: export / print PDF
  async export(me) {
    const { records } = await api("/records");
    const select = $("#rc");
    [...new Set(records.map((r) => r.course))].forEach((c) => select.add(new Option(c, c)));
    const draw = () => {
      const list = records.filter((r) => !select.value || r.course === select.value);
      $("#rb").innerHTML = recordRows(list, "No records to export yet.", false);
      $("#cnt").textContent = list.length;
      $("#rt").textContent = select.value || "All courses";
      $("#print").disabled = $("#pdf").disabled = !list.length;
    };
    select.onchange = draw;
    draw();
    $("#print").onclick = () => window.print();
    $("#pdf").onclick = () => {
      if (!window.jspdf) return window.print(); // offline fallback
      const doc = new window.jspdf.jsPDF();
      doc.setFontSize(18);
      doc.text("Attendance Pro - Attendance Report", 14, 18);
      doc.setFontSize(10);
      doc.text(
        `${$("#rt").textContent}  |  ${new Date().toLocaleDateString()}  |  ${me.name}`,
        14,
        26,
      );
      doc.autoTable({
        html: "#rep",
        startY: 32,
        headStyles: { fillColor: [10, 29, 74] },
        styles: { fontSize: 9 },
      });
      doc.save("attendance-report.pdf");
    };
  },

  // Login and sign up
  login() {
    let signup = false;
    const draw = () => {
      $("#ttl").textContent = signup ? "Lecturer sign up" : "Lecturer login";
      $("#idl").textContent = "Staff email";
      $("#id").type = "email";
      $("#nmw").hidden = !signup;
      $("#nm").required = signup;
      $("#sub").textContent = signup ? "Create account" : "Log in";
      $("#tx").textContent = signup ? "Already have an account?" : "No account yet?";
      $("#sw").textContent = signup ? "Log in" : "Create one";
      $("#msg").textContent = "";
    };
    $("#sw").onclick = (e) => {
      e.preventDefault();
      signup = !signup;
      draw();
    };
    draw();
    $("#af").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(signup ? "/auth/register" : "/auth/login", {
          method: "POST",
          body: { email: $("#id").value, name: $("#nm").value, password: $("#pw").value },
        });
        location.href = "dashboard.html";
      } catch (err) {
        $("#msg").textContent = err.message;
      }
    };
  },
};

// ----------------------------------------------------------------------------
// Start-up: check login for protected pages, then run the page's code
// ----------------------------------------------------------------------------
(async function init() {
  const page = document.body.dataset.page;
  let me = null;

  if (document.body.hasAttribute("data-auth")) {
    try {
      me = (await api("/auth/me")).user;
    } catch {
      /* not logged in */
    }
    if (!me) return void (location.href = "login.html");
    document.querySelectorAll(".uname").forEach((e) => (e.textContent = me.name));
    $(".out")?.addEventListener("click", async (e) => {
      e.preventDefault();
      await api("/auth/logout", { method: "POST" }).catch(() => {});
      location.href = e.currentTarget.href;
    });
  }
  try {
    await pages[page]?.(me);
  } catch (err) {
    console.error(err);
  }
})();
