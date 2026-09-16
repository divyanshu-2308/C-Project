import { db, ensureAuth } from "./firebase-config.js";
import {
  collection, query, where, getDocs, doc, getDoc, setDoc, updateDoc,
  increment, arrayUnion, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  shuffle, safeId, fmtTime, displayOptions, readingSeconds, extraMinutes, attemptMinutes,
} from "./common.js";
import { createProctor, goFullscreen, exitFullscreen } from "./proctor.js";

// ---------------------------------------------------------------------------
// Student quiz runner
//   * correct answers are NEVER sent to this page — grading happens in admin
//   * full-screen enforced, violations counted, auto-submit at the limit
//   * all timing is derived from the Firestore server clock, not the device
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const views = {
  login: $("loginView"), ready: $("readyView"),
  quiz: $("quizView"), result: $("resultView"), rescue: $("rescueView"),
};
function show(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
}
function msg(el, text, kind = "err") {
  el.innerHTML = text ? `<div class="notice ${kind}">${text}</div>` : "";
}

// ---- State ----
let quizzes = [];
let quiz = null;
let attemptRef = null;
let attemptId = null;
let uid = null;
let answers = {};
let order = [];
let violations = 0;
let maxViolations = 3;
let timerHandle = null;
let heartbeatHandle = null;
let deadlineAt = 0;        // in SERVER time
let clockOffset = 0;       // serverNow - Date.now()
let grantedExtra = 0;      // extra minutes added by faculty after a disconnection
let submitting = false;
let finished = false;
let saveTimer = null;
let paused = false;        // proctor overlay is up
let pendingWrites = 0;

const LS_KEY = "quizAttempt_v2";
const now = () => Date.now() + clockOffset;   // server-aligned clock

// ---- Boot ----
init();
async function init() {
  const user = await ensureAuth();
  uid = user ? user.uid : null;
  await loadQuizzes();
  $("startBtn").addEventListener("click", onContinue);
  $("beginBtn").addEventListener("click", onBegin);
  $("agree").addEventListener("change", syncBeginBtn);
  $("submitBtn").addEventListener("click", () => confirmSubmit("manual"));
  $("submitBtn2").addEventListener("click", () => confirmSubmit("manual"));
  $("resumeBtn").addEventListener("click", resumeFromViolation);
  $("retryBtn").addEventListener("click", () => doSubmit(lastSubmitReason, true));
  $("downloadBtn").addEventListener("click", downloadReceipt);

  if (!document.documentElement.requestFullscreen) {
    $("fsWarn").innerHTML =
      "⚠ This browser does not support full screen. Please switch to Chrome, Edge or Firefox on a laptop.";
  }
}

async function loadQuizzes() {
  const sel = $("quizSelect");
  try {
    const q = query(collection(db, "quizzes"), where("active", "==", true));
    const snap = await getDocs(q);
    quizzes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (quizzes.length === 0) {
      sel.innerHTML = `<option value="">No active quizzes right now</option>`;
      return;
    }
    sel.innerHTML = quizzes
      .map((z) => `<option value="${z.id}">${escapeHtml(z.title)} (${z.durationMinutes} min)</option>`)
      .join("");
  } catch (e) {
    console.error(e);
    sel.innerHTML = `<option value="">Could not load quizzes</option>`;
    msg($("loginMsg"), "Could not reach the quiz server. Check your connection.", "err");
  }
}

// ---- Step 1 -> 2 ----
async function onContinue() {
  const name = $("name").value.trim();
  const sapId = $("sapId").value.trim();
  const quizId = $("quizSelect").value;
  if (!name) return msg($("loginMsg"), "Please enter your name.");
  if (!sapId) return msg($("loginMsg"), "Please enter your SAP ID.");
  if (!quizId) return msg($("loginMsg"), "Please select a quiz.");
  if (!uid) return msg($("loginMsg"), "Could not sign in to the quiz server. Reload the page.");
  msg($("loginMsg"), "");

  $("startBtn").disabled = true;
  try {
    const zdoc = await getDoc(doc(db, "quizzes", quizId));
    if (!zdoc.exists()) throw new Error("Quiz not found");
    quiz = { id: quizId, ...zdoc.data() };
    maxViolations = Math.max(1, quiz.maxViolations || 3);
    $("ruleMax").textContent = maxViolations;
    $("switchMax").textContent = maxViolations;
    $("proctorMax").textContent = maxViolations;

    attemptId = `${quizId}__${safeId(sapId)}`;
    attemptRef = doc(db, "attempts", attemptId);

    let existing = null;
    try {
      const snap = await getDoc(attemptRef);
      existing = snap.exists() ? snap.data() : null;
    } catch (e) {
      console.warn("attempt read failed:", e.code, e.message);
      $("startBtn").disabled = false;
      if (e.code === "permission-denied") {
        // With the published rules, a non-existent attempt reads back cleanly,
        // so a denial here means the document exists and belongs to another
        // browser session.
        return msg($("loginMsg"),
          "This SAP ID already has an attempt started on another device or browser. " +
          "If that was you and the other device is gone, ask your instructor to press " +
          "<b>Allow resume</b> on the dashboard, then try again. If it was not you, " +
          "tell your instructor now.", "warn");
      }
      return msg($("loginMsg"),
        "Could not reach the quiz server (" + escapeHtml(e.code || "network error") +
        "). Check your connection and try again.", "err");
    }

    if (existing && existing.status === "submitted") {
      $("startBtn").disabled = false;
      return msg($("loginMsg"),
        "You have already submitted this quiz. You cannot take it again.", "warn");
    }

    $("whoami").textContent = `${name} · ${sapId}`;
    window.__student = { name, sapId };

    if (existing && existing.status === "in-progress") {
      await resumeAttempt(existing);
    } else {
      showReady();
    }
  } catch (e) {
    console.error(e);
    msg($("loginMsg"), "Something went wrong starting the quiz. Please try again.");
  } finally {
    $("startBtn").disabled = false;
  }
}

function showReady() {
  $("readyTitle").textContent = quiz.title;
  $("readyMeta").textContent =
    `${(quiz.questions || []).length} questions · ${quiz.durationMinutes} minutes · ` +
    `${quiz.marksPerQuestion} mark(s) each` +
    (quiz.negativeMarks ? ` · −${quiz.negativeMarks} for a wrong answer` : "");
  const instr = quiz.instructions || "";
  $("readyInstructions").style.display = instr ? "block" : "none";
  $("readyInstructions").textContent = instr;
  show("ready");
  startReadingGate(readingSeconds(quiz));
}

// ---- Compulsory reading time before the quiz can be started ----
let readHandle = null;
let readingUnlocked = false;

function startReadingGate(total) {
  clearInterval(readHandle);
  readingUnlocked = total <= 0;

  $("agree").checked = false;
  $("agree").disabled = !readingUnlocked;
  $("beginBtn").disabled = true;

  const gate = $("readGate");
  if (readingUnlocked) {           // readingMinutes: 0 — no gate at all
    gate.classList.add("hidden");
    syncBeginBtn();
    return;
  }

  gate.classList.remove("hidden", "unlocked");
  let left = total;
  $("readTimer").textContent = fmtTime(left);
  readHandle = setInterval(() => {
    left -= 1;
    $("readTimer").textContent = fmtTime(Math.max(0, left));
    if (left <= 0) {
      clearInterval(readHandle);
      readHandle = null;
      unlockReading();
    }
  }, 1000);
}

function unlockReading() {
  readingUnlocked = true;
  $("agree").disabled = false;
  $("readGate").classList.add("unlocked");
  $("readTimer").textContent = "00:00";
  $("readGateNote").innerHTML =
    "Reading time is over. Tick the box below, then start the quiz when you are ready.";
  syncBeginBtn();
}

// The Start button needs BOTH the reading time to have elapsed and the
// declaration to be ticked.
function syncBeginBtn() {
  $("beginBtn").disabled = !(readingUnlocked && $("agree").checked);
}

// ---- Step 2 -> 3 : fresh start ----
async function onBegin() {
  if (!readingUnlocked) return;      // defence in depth: gate not yet passed
  clearInterval(readHandle);
  readHandle = null;
  $("beginBtn").disabled = true;
  const qs = quiz.questions || [];
  order = (quiz.shuffle ? shuffle(qs) : qs).map((q) => q.id);
  answers = {};
  violations = 0;

  // Full screen must be requested inside this click (browser requirement).
  await goFullscreen();

  try {
    await setDoc(attemptRef, {
      uid,
      quizId: quiz.id,
      quizTitle: quiz.title,
      name: window.__student.name,
      sapId: window.__student.sapId,
      status: "in-progress",
      startedAt: serverTimestamp(),
      submittedAt: null,
      lastSeenAt: serverTimestamp(),
      durationMinutes: quiz.durationMinutes,
      violations: 0,
      violationLog: [],
      answers: {},
      order,
      score: null,
      graded: false,
      maxScore: qs.length * (quiz.marksPerQuestion || 1),
      totalQuestions: qs.length,
      autoSubmitted: false,
      submitReason: null,
      userAgent: navigator.userAgent.slice(0, 300),
    });
  } catch (e) {
    console.error(e);
    exitFullscreen();
    $("beginBtn").disabled = false;
    return msg($("loginMsg"),
      "Your SAP ID is not on the list for this quiz, or the server refused the attempt. " +
      "Please check the ID with your instructor.", "err");
  }

  // Read the server's own timestamp back, so the countdown cannot be extended
  // by changing the device clock.
  const fresh = await getDoc(attemptRef);
  const startedMs = toMillis(fresh.data().startedAt) || Date.now();
  clockOffset = startedMs - Date.now();
  deadlineAt = startedMs + attemptMinutes(quiz, fresh.data()) * 60 * 1000;

  persistLocal();
  enterQuiz();
}

// ---- Resume an interrupted attempt ----
async function resumeAttempt(data) {
  answers = data.answers || {};
  violations = data.violations || 0;
  order = (data.order && data.order.length)
    ? data.order
    : (quiz.questions || []).map((q) => q.id);

  // Faculty pressed "Allow resume" on the dashboard: the attempt may be picked
  // up on a device other than the one that started it. Claiming it ties the
  // attempt to THIS browser and consumes the grant, so nobody can walk in
  // behind the student on the same SAP ID.
  if (data.resumeAllowed && data.uid !== uid) {
    try {
      await updateDoc(attemptRef, { uid, resumeAllowed: false, lastSeenAt: serverTimestamp() });
    } catch (e) {
      console.warn("resume claim failed", e);
      return msg($("loginMsg"),
        "The server would not hand this attempt over to this device. Ask your " +
        "instructor to press <b>Allow resume</b> again, then reload this page.", "err");
    }
  }

  // Fall back to what we just read, then let the clock sync refine it — that
  // way a resume still works when the network is too poor to sync.
  const startedMs = toMillis(data.startedAt) || (now() - 1000);
  deadlineAt = startedMs + attemptMinutes(quiz, data) * 60 * 1000;
  await syncClock();
  if (finished) return;            // faculty closed the attempt while we synced

  await goFullscreen();
  persistLocal();
  enterQuiz();

  if (violations > 0) {
    msg($("loginMsg"), "");
  }
}

// Writes a server timestamp and reads it back to align the local clock. The
// same read picks up extra time granted from the dashboard while the quiz is
// running, so the student does not have to reload to receive it.
async function syncClock() {
  try {
    await updateDoc(attemptRef, { lastSeenAt: serverTimestamp() });
    const snap = await getDoc(attemptRef);
    const data = snap.data() || {};
    const serverNow = toMillis(data.lastSeenAt);
    if (serverNow) clockOffset = serverNow - Date.now();
    if (data.status === "submitted" && !finished && !submitting) return endByFaculty();
    applyGrantedTime(data);
  } catch (e) {
    console.warn("clock sync failed", e);
  }
}

// Faculty pressed "Force submit" on the dashboard while this browser was still
// open. Close the paper here too, rather than letting the student keep
// answering into a document the rules will no longer accept.
function endByFaculty() {
  finished = true;
  clearInterval(timerHandle);
  clearInterval(heartbeatHandle);
  clearTimeout(saveTimer);
  disableProctoring();
  exitFullscreen();
  $("proctorOverlay").classList.add("hidden");
  localStorage.removeItem(LS_KEY);
  const answered = order.filter((qid) => (answers[qid] || []).length > 0).length;
  $("resultTitle").textContent = "Attempt closed";
  $("resultMeta").textContent =
    "Your instructor closed this attempt. The answers already saved on the server were kept.";
  $("rAnswered").textContent = `${answered} / ${order.length}`;
  $("rSwitches").textContent = violations;
  $("rReceipt").textContent = receiptCode();
  show("result");
}

// Extra minutes are added to the ORIGINAL start time, so a grant is worth the
// same whether it arrives now or after a reload — and the timer still cannot be
// stretched from the student's side.
function applyGrantedTime(data) {
  const startedMs = toMillis(data.startedAt);
  if (!startedMs) return;
  deadlineAt = startedMs + attemptMinutes(quiz, data) * 60 * 1000;

  const granted = extraMinutes(data);
  if (granted === grantedExtra) return;
  grantedExtra = granted;
  const chip = $("extraChip");
  chip.classList.toggle("hidden", granted === 0);
  chip.textContent = granted ? `+${granted} min granted` : "";
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts.seconds) return ts.seconds * 1000;
  return 0;
}

// ---- Enter quiz ----
function enterQuiz() {
  $("quizViewTitle").textContent = quiz.title;
  $("switchCount").textContent = violations;
  renderQuestions();
  addWatermark();
  enableProctoring();
  startTimer();
  startHeartbeat();
  show("quiz");
  if (now() >= deadlineAt) confirmSubmit("time", true);
}

// ---- Render ----
function renderQuestions() {
  const byId = Object.fromEntries((quiz.questions || []).map((q) => [q.id, q]));
  const container = $("questions");
  container.innerHTML = order.map((qid, i) => {
    const q = byId[qid];
    if (!q) return "";
    const type = q.multi ? "checkbox" : "radio";
    // Options are ordered differently for every student (deterministically, so a
    // refresh keeps the same layout). The value submitted is the ORIGINAL key,
    // so grading is unaffected — only what the student sees changes.
    const opts = displayOptions(q, attemptId).map((o) => {
      const checked = (answers[qid] || []).includes(o.key);
      return `
        <label class="opt ${checked ? "checked" : ""}" data-qid="${qid}" data-key="${escapeHtml(o.key)}">
          <input type="${type}" name="q_${qid}" value="${escapeHtml(o.key)}" ${checked ? "checked" : ""} />
          <span><span class="key">${escapeHtml(o.label)}.</span> ${escapeHtml(o.text)}</span>
        </label>`;
    }).join("");
    return `
      <div class="card q-block" id="qc_${qid}">
        <div class="q-num">QUESTION ${i + 1} OF ${order.length}${q.multi ? " · select all that apply" : ""}</div>
        <div class="q-text">${escapeHtml(q.question)}</div>
        ${opts}
      </div>`;
  }).join("");

  container.querySelectorAll(".opt").forEach((el) => {
    el.addEventListener("click", () => setTimeout(() => onAnswerChange(el.dataset.qid), 0));
  });
  renderDots();
}

function onAnswerChange(qid) {
  const inputs = document.querySelectorAll(`input[name="q_${qid}"]`);
  const sel = [];
  inputs.forEach((inp) => { if (inp.checked) sel.push(inp.value); });
  answers[qid] = sel;
  document.querySelectorAll(`#qc_${qid} .opt`).forEach((el) => {
    el.classList.toggle("checked", sel.includes(el.dataset.key));
  });
  renderDots();
  persistLocal();
  scheduleSave();
}

function renderDots() {
  $("dots").innerHTML = order.map((qid, i) => {
    const answered = (answers[qid] || []).length > 0;
    return `<button class="dot ${answered ? "answered" : ""}" data-qid="${qid}">${i + 1}</button>`;
  }).join("");
  $("dots").querySelectorAll(".dot").forEach((d) => {
    d.addEventListener("click", () => {
      document.getElementById(`qc_${d.dataset.qid}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

// ---- Timer (server-aligned, never pauses) ----
function startTimer() {
  updateTimer();
  timerHandle = setInterval(updateTimer, 1000);
}
function updateTimer() {
  const remain = Math.round((deadlineAt - now()) / 1000);
  const t = $("timer");
  t.textContent = fmtTime(remain);
  t.classList.toggle("low", remain <= 60);
  $("proctorTimer").textContent = fmtTime(remain);
  if (remain <= 0) {
    clearInterval(timerHandle);
    confirmSubmit("time", true);
  }
}

// Periodic save + presence + clock re-sync (also caps data loss at ~20 s).
function startHeartbeat() {
  heartbeatHandle = setInterval(async () => {
    if (finished) return;
    await safeUpdate({ answers, lastSeenAt: serverTimestamp() });
    if (Math.random() < 0.34) await syncClock();
  }, 20000);
}

// ---------------------------------------------------------------------------
// Proctoring
// ---------------------------------------------------------------------------
let proctor = null;
let focusHandlers = [];

function enableProctoring() {
  proctor = createProctor({
    maxViolations,
    onViolation: (count, kind, remaining) => {
      violations = count;
      recordViolation(kind);
      showOverlay(
        "Assessment paused",
        `You left the quiz window (${escapeHtml(kind)}). This is violation ${count} of ` +
        `${maxViolations}. ${remaining} remaining — on the last one your quiz is ` +
        `submitted automatically.`,
        true
      );
    },
    onLimit: (count, kind) => {
      violations = count;
      recordViolation(kind);
      showOverlay(
        "Attempt ended",
        `That was violation ${count} of ${maxViolations}. Your quiz is being submitted automatically.`,
        false
      );
      confirmSubmit("proctoring", true);
    },
  });
  proctor.count = violations;   // resumed attempts keep their history
  proctor.attach();

  // Hide the paper the instant focus is lost, so a screenshot taken while
  // switching away captures nothing useful.
  addFocusHandler(window, "blur", () => document.body.classList.add("screen-hidden"));
  addFocusHandler(window, "focus", () => { if (!paused) document.body.classList.remove("screen-hidden"); });
  addFocusHandler(window, "beforeunload", beforeUnload);
}

function addFocusHandler(target, evt, fn) {
  target.addEventListener(evt, fn);
  focusHandlers.push([target, evt, fn]);
}

function disableProctoring() {
  proctor?.detach();
  focusHandlers.forEach(([t, e, f]) => t.removeEventListener(e, f));
  focusHandlers = [];
  document.body.classList.remove("screen-hidden");
  document.querySelector(".wm")?.remove();
}

function beforeUnload(e) {
  if (submitting || finished) return;
  e.preventDefault();
  e.returnValue = "";
}

// Push a violation to Firestore and the local mirror.
function recordViolation(kind) {
  $("switchCount").textContent = violations;
  persistLocal();
  safeUpdate({
    violations: increment(1),
    violationLog: arrayUnion({ at: Date.now(), kind }),
    answers,
    lastSeenAt: serverTimestamp(),
  });
}

function showOverlay(title, body, canResume) {
  paused = true;
  document.body.classList.add("screen-hidden");
  $("proctorTitle").textContent = title;
  $("proctorBody").innerHTML = body;
  $("proctorCount").textContent = violations;
  $("resumeBtn").classList.toggle("hidden", !canResume);
  $("proctorOverlay").classList.remove("hidden");
}

async function resumeFromViolation() {
  await goFullscreen();
  paused = false;
  $("proctorOverlay").classList.add("hidden");
  document.body.classList.remove("screen-hidden");
}

function addWatermark() {
  if (document.querySelector(".wm")) return;
  const wm = document.createElement("div");
  wm.className = "wm";
  wm.textContent = `${window.__student.sapId} · ${window.__student.name}`;
  document.body.appendChild(wm);
}

// ---------------------------------------------------------------------------
// Persistence — retrying writes, local mirror, offline tolerance
// ---------------------------------------------------------------------------
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => safeUpdate({ answers, lastSeenAt: serverTimestamp() }), 800);
}

async function safeUpdate(fields, attempts = 4) {
  pendingWrites += 1;
  paintNet();
  for (let i = 0; i < attempts; i++) {
    try {
      await updateDoc(attemptRef, fields);
      pendingWrites -= 1;
      paintNet(true);
      return true;
    } catch (e) {
      if (i === attempts - 1) {
        console.warn("write failed", e);
        pendingWrites -= 1;
        paintNet();
        return false;
      }
      await sleep(600 * Math.pow(2, i));
    }
  }
  return false;
}

function paintNet(justSaved) {
  $("netChip").classList.toggle("hidden", pendingWrites === 0);
  if (justSaved) {
    const chip = $("savedChip");
    chip.classList.add("flash");
    setTimeout(() => chip.classList.remove("flash"), 700);
  }
}

function persistLocal() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      attemptId, quizId: quiz?.id, quizTitle: quiz?.title,
      name: window.__student?.name, sapId: window.__student?.sapId,
      answers, order, violations, deadlineAt, savedAt: Date.now(),
    }));
  } catch (e) { /* storage full / disabled — non-fatal */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------
let lastSubmitReason = "manual";

function confirmSubmit(reason, auto = false) {
  if (submitting || finished) return;
  if (!auto) {
    const unanswered = order.filter((qid) => (answers[qid] || []).length === 0).length;
    const note = unanswered ? `\n\nYou have ${unanswered} unanswered question(s).` : "";
    if (!window.confirm(`Submit your quiz now? This cannot be undone.${note}`)) return;
  }
  doSubmit(reason);
}

async function doSubmit(reason, isRetry = false) {
  if (submitting) return;
  submitting = true;
  lastSubmitReason = reason;
  clearInterval(timerHandle);
  clearInterval(heartbeatHandle);
  clearTimeout(saveTimer);
  if (isRetry) $("retryBtn").disabled = true;

  const payload = {
    status: "submitted",
    submittedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
    answers,
    order,
    violations,
    autoSubmitted: reason !== "manual",
    submitReason: reason,
  };

  const ok = await safeUpdate(payload, 6);
  if (!ok) {
    submitting = false;
    if (isRetry) $("retryBtn").disabled = false;
    $("proctorOverlay").classList.add("hidden");
    document.body.classList.remove("screen-hidden");
    show("rescue");
    return;
  }

  finished = true;
  disableProctoring();
  exitFullscreen();
  $("proctorOverlay").classList.add("hidden");
  localStorage.removeItem(LS_KEY);

  const answered = order.filter((qid) => (answers[qid] || []).length > 0).length;
  $("resultMeta").textContent =
    reason === "time" ? "Time expired — your answers were submitted automatically."
      : reason === "proctoring" ? "Submitted automatically after repeated proctoring violations."
        : "Your answers have been recorded.";
  $("resultTitle").textContent = reason === "proctoring" ? "Attempt ended" : "Submitted ✅";
  $("rAnswered").textContent = `${answered} / ${order.length}`;
  $("rSwitches").textContent = violations;
  $("rReceipt").textContent = receiptCode();
  show("result");
}

function receiptCode() {
  const base = `${attemptId}|${Object.keys(answers).length}|${violations}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().slice(0, 8);
}

function downloadReceipt() {
  const data = {
    attemptId, quizId: quiz?.id, quizTitle: quiz?.title,
    name: window.__student?.name, sapId: window.__student?.sapId,
    answers, order, violations,
    localTime: new Date().toISOString(),
    note: "Backup receipt — submission to the server was not confirmed.",
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `quiz_receipt_${safeId(window.__student?.sapId || "student")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- utils ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
