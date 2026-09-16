import {
  db, auth, signInAdmin, signOutAdmin, onAdminChange, isAdminUser,
} from "./firebase-config.js";
import {
  collection, doc, setDoc, updateDoc, getDoc, getDocs, query, where, orderBy, onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  normalizeQuestions, readMeta, splitKey, mergeKey, parseRoster, gradeAttempt,
  displayOptions, STALE_MS, extraMinutes,
} from "./common.js";

const $ = (id) => document.getElementById(id);
function msg(el, text, kind = "err") {
  el.innerHTML = text ? `<div class="notice ${kind}">${text}</div>` : "";
}

let uploadedRaw = null;
let uploadedQuestions = null;
let monitorUnsub = null;
let currentRows = [];
let started = false;

// ---------------------------------------------------------------------------
// Sign in (real Firebase Auth — the Firestore rules check the same account)
// ---------------------------------------------------------------------------
$("gateBtn").addEventListener("click", enter);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });

async function enter() {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) return msg($("gateMsg"), "Enter your email and password.");
  $("gateBtn").disabled = true;
  msg($("gateMsg"), "");
  try {
    await signInAdmin(email, password);
  } catch (e) {
    msg($("gateMsg"), "Sign-in failed: " + friendlyAuthError(e));
  } finally {
    $("gateBtn").disabled = false;
  }
}

onAdminChange((user) => {
  if (user && isAdminUser(user)) {
    $("gateView").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("whoAdmin").innerHTML =
      `${escapeHtml(user.email)} · <a href="#" id="signOutLink" style="color:#fff">sign out</a>`;
    $("signOutLink").addEventListener("click", (e) => { e.preventDefault(); signOutAdmin(); });
    if (!started) { started = true; initApp(); }
  } else {
    $("gateView").classList.remove("hidden");
    $("app").classList.add("hidden");
    $("whoAdmin").textContent = "";
    // An anonymous session (left over from opening the student page in this
    // browser) is not an error — just show the sign-in form.
    if (user && user.email && !isAdminUser(user)) {
      msg($("gateMsg"), "That account is not on the faculty list.", "err");
      signOutAdmin();
    }
  }
});

function friendlyAuthError(e) {
  const c = (e && e.code) || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password")) return "wrong email or password.";
  if (c.includes("user-not-found")) return "no such account — create it in Firebase → Authentication → Users.";
  if (c.includes("operation-not-allowed")) return "Email/Password sign-in is not enabled in your Firebase project.";
  if (c.includes("too-many-requests")) return "too many attempts — wait a minute and retry.";
  return e.message || String(e);
}

// ---------------------------------------------------------------------------
function initApp() {
  $("jsonFile").addEventListener("change", onFile);
  $("rosterFile").addEventListener("change", onRosterFile);
  $("roster").addEventListener("input", onRosterInput);
  $("saveQuizBtn").addEventListener("click", saveQuiz);
  $("monitorQuiz").addEventListener("change", startMonitor);
  $("exportBtn").addEventListener("click", exportCsv);
  $("reportBtn").addEventListener("click", downloadAllAttempts);
  $("gradeBtn").addEventListener("click", gradeAll);
  $("closeQuizBtn").addEventListener("click", closeQuiz);
  // Delegated: the rows are re-rendered on every snapshot, so per-button
  // listeners would be lost every few seconds.
  $("rows").addEventListener("click", onRowAction);
  loadQuizList();
  setInterval(() => renderRows(currentRows), 15000); // refresh "live" column
}

// ---- Upload questions ----
function onFile(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      uploadedRaw = JSON.parse(reader.result);
      uploadedQuestions = normalizeQuestions(uploadedRaw);
      if (!uploadedQuestions.length) throw new Error("No questions found in file");

      const missing = uploadedQuestions.filter((q) => !q.correct || !q.correct.length);
      const meta = readMeta(uploadedRaw);
      if (!$("title").value.trim()) {
        $("title").value = meta.assessment || meta.course || file.name.replace(/\.json$/i, "");
      }
      $("jsonInfo").innerHTML =
        `✅ <b>${uploadedQuestions.length}</b> questions loaded` +
        (meta.course ? ` · ${escapeHtml(meta.course)}` : "") +
        (missing.length
          ? `<br><span style="color:var(--bad)">⚠ ${missing.length} question(s) have no correct answer marked — they would score 0 for everyone.</span>`
          : "");
      refreshSaveState();
      msg($("createMsg"), "");
    } catch (e) {
      uploadedQuestions = null;
      $("jsonInfo").textContent = "";
      refreshSaveState();
      msg($("createMsg"), "Could not read that file: " + e.message);
    }
  };
  reader.readAsText(file);
}

// ---- Roster ----
function onRosterFile(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("roster").value = String(reader.result);
    onRosterInput();
  };
  reader.readAsText(file);
}

function onRosterInput() {
  const ids = parseRoster($("roster").value);
  $("rosterInfo").innerHTML = ids.length
    ? `✅ <b>${ids.length}</b> SAP ID(s) on the roster. Only these students can start the quiz.`
    : `No roster loaded — <b>the quiz cannot be saved without one</b>.`;
  refreshSaveState();
}

function refreshSaveState() {
  const ok = !!uploadedQuestions && parseRoster($("roster").value).length > 0;
  $("saveQuizBtn").disabled = !ok;
}

// ---- Save quiz (splits public questions from the answer key) ----
async function saveQuiz() {
  if (!uploadedQuestions) return;
  const title = $("title").value.trim();
  if (!title) return msg($("createMsg"), "Please enter a quiz title.");
  const roster = parseRoster($("roster").value);
  if (!roster.length) return msg($("createMsg"), "Please add the allowed SAP IDs.");

  const meta = readMeta(uploadedRaw);
  const quizId = slug(title) + "_" + Date.now().toString(36);
  const { publicQuestions, correct, explanations } = splitKey(uploadedQuestions);

  const publicDoc = {
    title,
    instructions: meta.instructions || "",
    durationMinutes: Math.max(1, parseInt($("duration").value, 10) || 20),
    marksPerQuestion: parseFloat($("marks").value) || 1,
    negativeMarks: parseFloat($("negative").value) || 0,
    maxViolations: Math.max(1, parseInt($("maxViolations").value, 10) || 3),
    readingMinutes: Math.max(0, parseInt($("readingMinutes").value, 10) || 0),
    active: $("active").value === "true",
    shuffle: $("shuffle").value === "true",
    questions: publicQuestions,          // no correct answers here
    totalQuestions: publicQuestions.length,
    createdAt: Date.now(),
  };

  $("saveQuizBtn").disabled = true;
  try {
    // Key first: if this fails, no half-published quiz exists for students.
    await setDoc(doc(db, "quizKeys", quizId), {
      correct, explanations, roster, createdAt: Date.now(), title,
    });
    await setDoc(doc(db, "quizzes", quizId), publicDoc);

    msg($("createMsg"),
      `Quiz "<b>${escapeHtml(title)}</b>" saved with <b>${roster.length}</b> students on the roster and ` +
      `${publicDoc.active ? "<b>is now ACTIVE</b>" : "saved as a draft"}. ` +
      `The answer key is stored separately in <code>quizKeys/${quizId}</code>.`, "ok");
    $("jsonFile").value = ""; $("jsonInfo").textContent = "";
    uploadedRaw = uploadedQuestions = null;
    refreshSaveState();
    await loadQuizList(quizId);
  } catch (e) {
    console.error(e);
    msg($("createMsg"), "Save failed: " + e.message +
      " — check that your account is in the Firestore rules.");
  } finally {
    refreshSaveState();
  }
}

// ---- Quiz list ----
async function loadQuizList(selectId) {
  const sel = $("monitorQuiz");
  try {
    const snap = await getDocs(query(collection(db, "quizzes"), orderBy("createdAt", "desc")));
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!items.length) {
      sel.innerHTML = `<option value="">No quizzes yet</option>`;
      return;
    }
    sel.innerHTML = items.map((z) =>
      `<option value="${z.id}">${escapeHtml(z.title)} ${z.active ? "· ACTIVE" : "· draft"}</option>`).join("");
    if (selectId) sel.value = selectId;
    startMonitor();
  } catch (e) {
    console.error(e);
    sel.innerHTML = `<option value="">Could not load quizzes</option>`;
  }
}

// ---- Live monitor ----
function startMonitor() {
  const quizId = $("monitorQuiz").value;
  if (monitorUnsub) monitorUnsub();
  msg($("monitorMsg"), "");
  if (!quizId) return;

  checkQuizHealth(quizId);

  const q = query(collection(db, "attempts"), where("quizId", "==", quizId));
  monitorUnsub = onSnapshot(q, (snap) => {
    currentRows = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    currentRows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    renderRows(currentRows);
  }, (err) => {
    console.error(err);
    $("rows").innerHTML =
      `<tr><td colspan="11" class="muted">Live updates unavailable: ${escapeHtml(err.message)}</td></tr>`;
  });
}

function isStale(r, nowMs) {
  return r.status !== "submitted" && !!ms(r.lastSeenAt) && (nowMs - ms(r.lastSeenAt) > STALE_MS);
}

function renderRows(rows) {
  const nowMs = Date.now();
  if (!rows.length) {
    $("rows").innerHTML = `<tr><td colspan="11" class="muted">No students yet.</td></tr>`;
  } else {
    $("rows").innerHTML = rows.map((r) => {
      const done = r.status === "submitted";
      const v = r.violations || 0;
      const stale = isStale(r, nowMs);
      const extra = extraMinutes(r);
      const statusPill = done
        ? `<span class="pill done">Submitted${r.autoSubmitted ? ` (${escapeHtml(r.submitReason || "auto")})` : ""}</span>`
        : `<span class="pill live">In progress</span>`;
      const answered = Object.values(r.answers || {}).filter((a) => a && a.length).length;
      const log = r.violationLog || [];
      const last = log.length ? log[log.length - 1] : null;
      // A granted resume the student has not picked up yet.
      const waiting = !done && r.resumeAllowed === true;
      const livePill = done ? "–"
        : waiting ? `<span class="pill warnpill">resume open</span>`
          : stale ? `<span class="pill flag">stale</span>`
            : `<span class="pill done">live</span>`;
      return `<tr>
        <td>${escapeHtml(r.name || "")}</td>
        <td class="mono">${escapeHtml(r.sapId || "")}</td>
        <td>${statusPill}${extra ? ` <span class="pill warnpill" title="Extra time granted">+${extra} min</span>` : ""}</td>
        <td class="right-align"><span class="pill ${v >= 2 ? "flag" : ""}">${v}</span></td>
        <td class="muted" style="font-size:.82rem">${last ? `${escapeHtml(last.kind || "")} · ${fmtDate(last.at)}` : "–"}</td>
        <td class="right-align">${answered}/${r.totalQuestions ?? "–"}</td>
        <td class="right-align">${r.score == null ? (r.graded ? "0" : "<span class='muted'>ungraded</span>") : `<b>${r.score}</b> / ${r.maxScore}`}</td>
        <td>${fmtDate(ms(r.startedAt))}</td>
        <td>${fmtDate(ms(r.submittedAt))}</td>
        <td>${livePill}</td>
        <td class="row-actions">
          <button class="btn secondary xs" data-act="resume" data-id="${escapeHtml(r._id)}">${done ? "Reopen" : "Allow resume"}</button>
          ${done ? "" : `<button class="btn secondary xs" data-act="submit" data-id="${escapeHtml(r._id)}">Force submit</button>`}
        </td>
      </tr>`;
    }).join("");
  }

  const total = rows.length;
  const done = rows.filter((r) => r.status === "submitted").length;
  const scored = rows.filter((r) => r.score != null);
  const avg = scored.length
    ? (scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(1) : "–";
  const stale = rows.filter((r) => isStale(r, nowMs)).length;
  $("sTotal").textContent = total;
  $("sLive").textContent = total - done;
  $("sDone").textContent = done;
  $("sAvg").textContent = avg;
  $("sFlag").textContent = rows.filter((r) => (r.violations || 0) >= 2).length;
  $("sStale").textContent = stale;
}

// ---------------------------------------------------------------------------
// Rescuing a disconnected student
// ---------------------------------------------------------------------------
// A "stale" row is a browser that stopped checking in: crash, sleep, flat
// battery or a dropped network. Faculty decide what happens to that attempt —
// close it as submitted, or let the student back in (on any device) with extra
// time to make up for what the clock ate while they were away.
async function onRowAction(ev) {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const row = currentRows.find((r) => r._id === btn.dataset.id);
  if (!row) return;
  btn.disabled = true;
  try {
    if (btn.dataset.act === "submit") await forceSubmit(row);
    else await allowResume(row);
  } finally {
    btn.disabled = false;
  }
}

async function forceSubmit(row) {
  const who = row.name || row.sapId || "this student";
  const answered = Object.values(row.answers || {}).filter((a) => a && a.length).length;
  if (!window.confirm(
    `Submit ${who}'s attempt as it stands?\n\n` +
    `${answered} of ${row.totalQuestions ?? "?"} question(s) are answered. The attempt ` +
    `is closed and can be graded, and the student cannot add to it afterwards.`)) return;
  try {
    await updateDoc(doc(db, "attempts", row._id), {
      status: "submitted",
      submittedAt: serverTimestamp(),
      autoSubmitted: true,
      submitReason: "faculty",
      resumeAllowed: false,
    });
    msg($("monitorMsg"),
      `<b>${escapeHtml(who)}</b> is now marked submitted with ${answered} answered ` +
      `question(s). Press <b>Grade all attempts</b> to score it.`, "ok");
  } catch (e) {
    console.error(e);
    msg($("monitorMsg"), "Could not submit that attempt: " + escapeHtml(e.message));
  }
}

async function allowResume(row) {
  const who = row.name || row.sapId || "this student";
  const lastSeen = ms(row.lastSeenAt);
  const lostMin = lastSeen ? Math.max(0, Math.round((Date.now() - lastSeen) / 60000)) : 0;
  const already = extraMinutes(row);

  if (row.status === "submitted" && !window.confirm(
    `${who}'s attempt is already SUBMITTED.\n\n` +
    `Reopening it lets them answer again and clears any score they were given, ` +
    `so the attempt will need re-grading. Continue?`)) return;

  const reply = window.prompt(
    `Let ${who} back into the quiz.\n\n` +
    `They sign in again with the same SAP ID — on any device — and carry on from the ` +
    `answers already saved on the server.\n\n` +
    `Their clock kept running while they were away (about ${lostMin} min lost).\n` +
    `TOTAL extra minutes for this attempt (0 for none):`,
    String(already + lostMin));
  if (reply === null) return;                       // cancelled

  const n = Number(String(reply).trim());
  if (!Number.isFinite(n) || n < 0) {
    return msg($("monitorMsg"), "That is not a number of minutes — nothing was changed.", "warn");
  }
  const grant = Math.round(n);

  const payload = {
    status: "in-progress",
    extraMinutes: grant,
    resumeAllowed: true,           // consumed by the first browser that resumes
    resumeGrantedAt: Date.now(),
  };
  if (row.status === "submitted") {
    // Reopening: the old submission and its score must not survive.
    Object.assign(payload, {
      submittedAt: null, autoSubmitted: false, submitReason: null,
      score: null, graded: false,
    });
  }

  try {
    await updateDoc(doc(db, "attempts", row._id), payload);
    msg($("monitorMsg"),
      `<b>${escapeHtml(who)}</b> may resume now` +
      (grant ? ` with <b>${grant} extra minute(s)</b>` : " with no extra time") +
      `. Tell them to reopen the quiz page and sign in with the same SAP ID. ` +
      `The row shows <b>resume open</b> until they are back` +
      (grant ? "" : " — grant extra minutes by pressing Allow resume again") + `.`, "ok");
  } catch (e) {
    console.error(e);
    msg($("monitorMsg"), "Could not reopen that attempt: " + escapeHtml(e.message));
  }
}

// Warns about quizzes saved before the security update: they have no answer key
// document and no roster, so (a) students cannot start them under the new rules
// and (b) their answers are still sitting in the student-readable document.
async function checkQuizHealth(quizId) {
  try {
    const [zSnap, kSnap] = await Promise.all([
      getDoc(doc(db, "quizzes", quizId)),
      getDoc(doc(db, "quizKeys", quizId)),
    ]);
    if (!zSnap.exists()) return;
    const z = zSnap.data();
    const leaks = (z.questions || []).some((q) => "correct" in q);
    if (!kSnap.exists() || leaks) {
      msg($("monitorMsg"),
        "<b>This quiz was created before the security update.</b> " +
        (leaks ? "Its correct answers are still stored in the student-readable document, and " : "") +
        "it has no roster, so students will be blocked by the new Firestore rules. " +
        "Re-upload the JSON above, add the roster, and save it again as a new quiz " +
        "before using it.", "err");
    }
  } catch (e) {
    console.warn("health check failed", e);
  }
}

// ---- Grading (faculty side only) ----
async function gradeAll() {
  const quizId = $("monitorQuiz").value;
  if (!quizId) return;
  if (!currentRows.length) return msg($("monitorMsg"), "No attempts to grade.", "warn");
  if (!window.confirm(`Grade ${currentRows.length} attempt(s) for this quiz?`)) return;

  $("gradeBtn").disabled = true;
  msg($("monitorMsg"), "Grading…", "warn");
  try {
    const [zSnap, kSnap] = await Promise.all([
      getDoc(doc(db, "quizzes", quizId)),
      getDoc(doc(db, "quizKeys", quizId)),
    ]);
    if (!zSnap.exists()) throw new Error("Quiz not found");
    if (!kSnap.exists()) throw new Error("Answer key not found for this quiz (was it saved before the update?)");

    const z = zSnap.data();
    const questions = mergeKey(z.questions, kSnap.data().correct);
    const marks = z.marksPerQuestion || 1;
    const neg = z.negativeMarks || 0;

    let graded = 0, failed = 0;
    for (const r of currentRows) {
      if (r.status !== "submitted") continue;
      const res = gradeAttempt(questions, r.answers || {}, marks, neg);
      try {
        await updateDoc(doc(db, "attempts", r._id), {
          score: res.score,
          maxScore: res.maxScore,
          correctCount: res.correctCount,
          totalQuestions: res.total,
          graded: true,
          gradedAt: Date.now(),
        });
        graded++;
      } catch (e) {
        console.error("grade failed for", r._id, e);
        failed++;
      }
    }
    msg($("monitorMsg"),
      `Graded <b>${graded}</b> submitted attempt(s)${failed ? `, <b>${failed}</b> failed` : ""}. ` +
      `Unsubmitted attempts were skipped.`, failed ? "warn" : "ok");
  } catch (e) {
    console.error(e);
    msg($("monitorMsg"), "Grading failed: " + e.message);
  } finally {
    $("gradeBtn").disabled = false;
  }
}

// ---- Close a quiz (stops new attempts immediately) ----
async function closeQuiz() {
  const quizId = $("monitorQuiz").value;
  if (!quizId) return;
  if (!window.confirm("Close this quiz? Students who have not started will no longer be able to.")) return;
  try {
    await updateDoc(doc(db, "quizzes", quizId), { active: false });
    msg($("monitorMsg"), "Quiz closed. Students already in progress can still submit.", "ok");
    await loadQuizList(quizId);
  } catch (e) {
    msg($("monitorMsg"), "Could not close the quiz: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Download every attempt as one file
// ---------------------------------------------------------------------------
// The CSV is a marks sheet; this is the paper itself. One self-contained HTML
// file holding every student's answers for the selected quiz — what they picked,
// what was correct, the explanation, plus a per-question breakdown of how the
// class did. It opens in any browser with no network, and prints to PDF one
// student per page.
async function downloadAllAttempts() {
  const quizId = $("monitorQuiz").value;
  if (!quizId) return;
  if (!currentRows.length) return msg($("monitorMsg"), "No attempts to download yet.", "warn");

  $("reportBtn").disabled = true;
  msg($("monitorMsg"), "Building the file…", "warn");
  try {
    const [zSnap, kSnap] = await Promise.all([
      getDoc(doc(db, "quizzes", quizId)),
      getDoc(doc(db, "quizKeys", quizId)),
    ]);
    if (!zSnap.exists()) throw new Error("Quiz not found");
    const z = zSnap.data();
    // A quiz saved before the security update has no key document. Still worth
    // downloading — it just cannot mark anything right or wrong.
    const key = kSnap.exists() ? kSnap.data() : { correct: {}, explanations: {} };
    const questions = mergeKey(z.questions, key.correct);

    const html = buildAttemptsReport({
      quizId, quiz: z, questions,
      explanations: key.explanations || {},
      rows: currentRows.slice(),
    });
    download(html, `quiz_attempts_${quizId}.html`, "text/html;charset=utf-8");

    msg($("monitorMsg"),
      `Downloaded <b>${currentRows.length}</b> attempt(s) as a single file` +
      (kSnap.exists() ? "" : " — <b>without</b> right/wrong marking, because this quiz has no answer key") +
      `. It contains the answer key, so keep it to yourself.`,
      kSnap.exists() ? "ok" : "warn");
  } catch (e) {
    console.error(e);
    msg($("monitorMsg"), "Could not build the file: " + escapeHtml(e.message));
  } finally {
    $("reportBtn").disabled = false;
  }
}

// Set comparison — the same exact-match rule the grader uses.
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((k) => s.has(k));
}

function buildAttemptsReport({ quizId, quiz, questions, explanations, rows }) {
  const marks = quiz.marksPerQuestion || 1;
  const neg = quiz.negativeMarks || 0;
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const hasKey = questions.some((q) => (q.correct || []).length);

  // ---- per student ----
  const sheets = rows.map((r, idx) => {
    const answers = r.answers || {};
    const order = (r.order && r.order.length) ? r.order : questions.map((q) => q.id);
    const graded = gradeAttempt(questions, answers, marks, neg);
    const answered = Object.values(answers).filter((a) => a && a.length).length;
    const items = order.map((qid, i) => {
      const q = byId[qid];
      if (!q) return "";
      const sel = answers[qid] || [];
      const ok = hasKey && sameSet(sel, q.correct || []);
      // Show the options in the order THIS student saw them, so "option B" in
      // the file means what it meant on their screen.
      const opts = displayOptions(q, r._id).map((o) => {
        const picked = sel.includes(o.key);
        const right = hasKey && (q.correct || []).includes(o.key);
        const cls = [picked ? "picked" : "", right ? "right" : ""].filter(Boolean).join(" ");
        const tag = picked && right ? "✓ chosen"
          : picked ? "✗ chosen"
            : right ? "correct answer" : "";
        return `<li class="${cls}"><b>${escapeHtml(o.label)}.</b> ${escapeHtml(o.text)}` +
          (tag ? ` <span class="tag">${tag}</span>` : "") + `</li>`;
      }).join("");
      const verdict = !sel.length ? `<span class="v skip">not answered</span>`
        : !hasKey ? ""
          : ok ? `<span class="v ok">correct</span>` : `<span class="v bad">wrong</span>`;
      const why = explanations[q.id];
      return `<div class="q">
        <div class="qh"><span class="qn">Q${i + 1}</span>${verdict}</div>
        <div class="qt">${escapeHtml(q.question)}${q.multi ? ` <span class="tag">select all that apply</span>` : ""}</div>
        <ul class="opts">${opts}</ul>
        ${why ? `<div class="why"><b>Why:</b> ${escapeHtml(why)}</div>` : ""}
      </div>`;
    }).join("");

    const head = `<div class="shead">
        <div>
          <h2>${escapeHtml(r.name || "(no name)")}</h2>
          <div class="meta mono">${escapeHtml(r.sapId || "")}</div>
        </div>
        <div class="score">${hasKey ? `${graded.score} / ${graded.maxScore}` : "–"}
          <div class="meta">${answered} of ${questions.length} answered${hasKey ? ` · ${graded.correctCount} correct` : ""}</div>
        </div>
      </div>
      <div class="meta srow">
        Status: <b>${escapeHtml(r.status || "?")}</b>${r.autoSubmitted ? ` (${escapeHtml(r.submitReason || "auto")})` : ""}
        · Violations: <b>${r.violations || 0}</b>
        · Started ${escapeHtml(fmtDate(ms(r.startedAt)) || "–")}
        · Submitted ${escapeHtml(fmtDate(ms(r.submittedAt)) || "–")}
        ${extraMinutes(r) ? `· <b>+${extraMinutes(r)} min granted</b>` : ""}
      </div>`;

    return { anchor: `s${idx}`, name: r.name || r.sapId || "(no name)", html:
      `<section class="sheet" id="s${idx}">${head}${items || `<p class="meta">No answers recorded.</p>`}</section>` };
  });

  // ---- how the class did on each question ----
  const items = questions.map((q, i) => {
    let attempted = 0, correct = 0;
    const tally = {};
    rows.forEach((r) => {
      const sel = (r.answers || {})[q.id] || [];
      if (!sel.length) return;
      attempted++;
      if (hasKey && sameSet(sel, q.correct || [])) correct++;
      sel.forEach((k) => { tally[k] = (tally[k] || 0) + 1; });
    });
    const pct = attempted ? Math.round((correct / attempted) * 100) : 0;
    const text = (k) => (q.options.find((o) => String(o.key) === String(k)) || {}).text || k;
    const popular = Object.entries(tally).sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${escapeHtml(String(text(k))).slice(0, 60)} (${n})`).slice(0, 3).join("<br>");
    return `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(q.question)}</td>
      <td class="num">${attempted}</td>
      <td class="num">${hasKey ? `${correct} (${pct}%)` : "–"}</td>
      <td class="small">${popular || "–"}</td>
    </tr>`;
  }).join("");

  const summary = rows.map((r, idx) => {
    const g = gradeAttempt(questions, r.answers || {}, marks, neg);
    const answered = Object.values(r.answers || {}).filter((a) => a && a.length).length;
    return `<tr>
      <td><a href="#s${idx}">${escapeHtml(r.name || "(no name)")}</a></td>
      <td class="mono">${escapeHtml(r.sapId || "")}</td>
      <td>${escapeHtml(r.status || "?")}${r.autoSubmitted ? ` (${escapeHtml(r.submitReason || "auto")})` : ""}</td>
      <td class="num">${answered}/${questions.length}</td>
      <td class="num">${hasKey ? `${g.score}/${g.maxScore}` : "–"}</td>
      <td class="num">${r.violations || 0}</td>
      <td class="small">${escapeHtml(fmtDate(ms(r.submittedAt)) || "–")}</td>
    </tr>`;
  }).join("");

  const submitted = rows.filter((r) => r.status === "submitted").length;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(quiz.title || quizId)} — all attempts</title>
<style>
  :root { --line:#dde5ec; --muted:#6b7c8a; --primary:#1a5276; --good:#1e8449; --bad:#c0392b; }
  * { box-sizing:border-box }
  body { font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; margin:0;
         padding:26px; color:#22313a; line-height:1.45; background:#f6f9fb }
  .wrap { max-width:940px; margin:0 auto }
  h1 { color:var(--primary); margin:0 0 4px; font-size:1.5rem }
  h2 { margin:0; font-size:1.15rem; color:var(--primary) }
  h3 { color:var(--primary); margin:30px 0 10px; font-size:1.05rem }
  .meta { color:var(--muted); font-size:.85rem }
  .mono { font-family:ui-monospace,"Cascadia Code",monospace }
  .banner { background:#fdecea; border:1px solid #f5c6cb; color:var(--bad);
            border-radius:8px; padding:10px 14px; margin:14px 0; font-size:.9rem }
  table { width:100%; border-collapse:collapse; font-size:.88rem; background:#fff;
          border:1px solid var(--line); border-radius:8px; overflow:hidden }
  th,td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--line);
          vertical-align:top }
  th { background:#f0f5f9; color:var(--primary); font-size:.78rem; text-transform:uppercase;
       letter-spacing:.03em }
  td.num { text-align:right; white-space:nowrap }
  td.small,.small { font-size:.8rem; color:var(--muted) }
  a { color:var(--primary) }
  .sheet { background:#fff; border:1px solid var(--line); border-radius:10px;
           padding:20px; margin:20px 0 }
  .shead { display:flex; justify-content:space-between; align-items:flex-start;
           gap:14px; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:10px }
  .score { font-size:1.35rem; font-weight:700; color:var(--primary); text-align:right }
  .srow { margin:8px 0 4px }
  .q { border-top:1px solid var(--line); padding:12px 0 4px }
  .qh { display:flex; align-items:center; gap:10px; margin-bottom:4px }
  .qn { font-weight:700; color:var(--muted); font-size:.8rem; letter-spacing:.04em }
  .qt { font-weight:600; margin-bottom:8px }
  .v { font-size:.75rem; font-weight:700; padding:1px 8px; border-radius:20px }
  .v.ok { background:#eafaf1; color:var(--good) } .v.bad { background:#fdecea; color:var(--bad) }
  .v.skip { background:#eef3f7; color:var(--muted) }
  ul.opts { list-style:none; margin:0; padding:0 }
  ul.opts li { padding:5px 10px; border:1px solid transparent; border-radius:6px;
               margin-bottom:3px; font-size:.92rem }
  li.right { background:#eafaf1; border-color:#bfe6cd }
  li.picked { border-color:var(--primary); background:#eef3f7 }
  li.picked.right { background:#eafaf1; border-color:var(--good) }
  .tag { font-size:.72rem; color:var(--muted); font-weight:600; text-transform:uppercase;
         letter-spacing:.03em }
  li.right .tag { color:var(--good) } li.picked:not(.right) .tag { color:var(--bad) }
  .why { background:#f6f9fb; border-left:3px solid var(--primary); padding:7px 11px;
         font-size:.85rem; margin:6px 0 2px; border-radius:0 6px 6px 0 }
  @media print {
    body { background:#fff; padding:0 }
    .sheet { page-break-before:always; border:0; padding:0 }
    .noprint { display:none }
  }
</style></head><body><div class="wrap">

  <h1>${escapeHtml(quiz.title || quizId)}</h1>
  <div class="meta">
    ${rows.length} attempt(s) · ${submitted} submitted · ${questions.length} questions ·
    ${quiz.durationMinutes} min · ${marks} mark(s) each${neg ? ` · −${neg} wrong` : ""}<br>
    Downloaded ${escapeHtml(new Date().toLocaleString())} · quiz id <span class="mono">${escapeHtml(quizId)}</span>
  </div>

  <div class="banner"><b>Faculty copy.</b> This file contains the correct answers${
    Object.keys(explanations).length ? " and the explanations" : ""}. Do not hand it to students as it is.</div>

  ${hasKey ? "" : `<div class="banner">No answer key was found for this quiz, so nothing is
    marked right or wrong — only what each student chose.</div>`}

  <h3>Summary</h3>
  <table><thead><tr>
    <th>Name</th><th>SAP ID</th><th>Status</th><th class="num">Answered</th>
    <th class="num">Score</th><th class="num">Viol.</th><th>Submitted</th>
  </tr></thead><tbody>${summary}</tbody></table>

  <h3>How the class did, question by question</h3>
  <table><thead><tr>
    <th>#</th><th>Question</th><th class="num">Attempted</th><th class="num">Correct</th>
    <th>Most chosen</th>
  </tr></thead><tbody>${items}</tbody></table>

  <h3>Answer sheets</h3>
  ${sheets.map((s) => s.html).join("")}

</div></body></html>`;
}

function download(text, filename, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- CSV ----
function exportCsv() {
  if (!currentRows.length) return;
  const head = ["Name", "SAP ID", "Status", "Submit reason", "Violations", "Violation times",
    "Answered", "Score", "Max", "Correct", "Started", "Submitted", "Duration (min)",
    "Extra minutes granted"];
  const lines = [head.join(",")];
  currentRows.forEach((r) => {
    const started = ms(r.startedAt), sub = ms(r.submittedAt);
    const answered = Object.values(r.answers || {}).filter((a) => a && a.length).length;
    const times = (r.violationLog || []).map((v) => `${v.kind}@${fmtDate(v.at)}`).join(" | ");
    lines.push([
      csv(r.name), csv(r.sapId), csv(r.status), csv(r.submitReason || ""),
      r.violations || 0, csv(times), answered,
      r.score ?? "", r.maxScore ?? "", r.correctCount ?? "",
      csv(fmtDate(started)), csv(fmtDate(sub)),
      started && sub ? ((sub - started) / 60000).toFixed(1) : "",
      extraMinutes(r) || "",
    ].join(","));
  });
  download(lines.join("\n"), `quiz_results_${$("monitorQuiz").value}.csv`, "text/csv");
}

// ---- utils ----
function ms(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  return 0;
}
function csv(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmtDate(msVal) {
  if (!msVal) return "";
  return new Date(msVal).toLocaleString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "short",
  });
}
function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "quiz";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
