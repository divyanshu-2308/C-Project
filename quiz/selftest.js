// ---------------------------------------------------------------------------
// Offline self-test. No Firebase. Open quiz/selftest.html to run.
// ---------------------------------------------------------------------------
import {
  normalizeQuestions, splitKey, mergeKey, parseRoster,
  gradeQuestion, gradeAttempt, shuffle, safeId, fmtTime,
  seededShuffle, displayOptions, readingSeconds, extraMinutes, attemptMinutes,
} from "./common.js";
import { createProctor, VIOLATION_DEBOUNCE_MS } from "./proctor.js";

const out = document.getElementById("results");
let pass = 0, fail = 0;

function group(name) {
  const d = document.createElement("div");
  d.className = "grp";
  d.textContent = name;
  out.appendChild(d);
}
function check(name, cond, why = "") {
  const ok = !!cond;
  ok ? pass++ : fail++;
  const d = document.createElement("div");
  d.className = "t-row " + (ok ? "pass" : "fail");
  d.innerHTML = `<span class="st">${ok ? "PASS" : "FAIL"}</span><span>${name}</span>` +
    (why && !ok ? `<span class="why">— ${why}</span>` : "");
  out.appendChild(d);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- fixtures -------------------------------------------------------------
const rawFormatA = {
  course: "CSEG3060",
  assessment: "Quiz 1",
  questions: [
    { id: 1, question: "Single answer?", options: { A: "a", B: "b", C: "c" }, correct_answer: "B" },
    { id: 2, question: "Multi answer?", options: { A: "a", B: "b", C: "c" }, correct_answers: ["A", "C"] },
  ],
};
const rawFormatB = [
  { question: "Index style?", options: ["zero", "one", "two"], correctAnswer: 2 },
];

// --- normalisation --------------------------------------------------------
group("Question normalisation");
const qa = normalizeQuestions(rawFormatA);
check("Format A: two questions parsed", qa.length === 2);
check("Format A: single-answer question is not multi", qa[0].multi === false);
check("Format A: correct key preserved", eq(qa[0].correct, ["B"]));
check("Format A: multi-answer flagged and both keys kept",
  qa[1].multi === true && eq(qa[1].correct, ["A", "C"]));
const qb = normalizeQuestions(rawFormatB);
check("Format B: index converted to a key", eq(qb[0].correct, ["2"]));
check("Re-normalising an already-normal question is stable",
  eq(normalizeQuestions(qa), qa));

// --- the security-critical split -----------------------------------------
group("Answer key is stripped from the student document");
const withExpl = normalizeQuestions({
  questions: [{
    id: 9, question: "Leaky?", options: { A: "a", B: "b" }, correct_answer: "A",
    explanation: "SECRET-GIVES-AWAY-THE-ANSWER",
  }],
});
const { publicQuestions, correct, explanations } = splitKey(qa);
const publicJson = JSON.stringify(publicQuestions);
check("No 'correct' field survives in the public questions",
  !publicJson.includes("correct"));
check("Explanations never reach the student document",
  !JSON.stringify(splitKey(withExpl).publicQuestions).includes("SECRET-GIVES-AWAY-THE-ANSWER"));
check("Explanations are preserved on the faculty side",
  splitKey(withExpl).explanations["9"] === "SECRET-GIVES-AWAY-THE-ANSWER");
check("Correct answer values are not leaked anywhere in the public JSON",
  publicQuestions.every((q) => !("correct" in q)));
check("Public questions keep id, text and options",
  publicQuestions[0].id === "1" && publicQuestions[0].options.length === 3);
check("Key document maps every question id", eq(Object.keys(correct), ["1", "2"]));
const merged = mergeKey(publicQuestions, correct);
check("mergeKey restores a gradable set for the dashboard",
  eq(merged[1].correct, ["A", "C"]) && merged[1].options.length === 3);

// --- grading --------------------------------------------------------------
group("Grading");
check("Exact single answer scores full marks", gradeQuestion(qa[0], ["B"], 1, 0) === 1);
check("Wrong single answer scores zero", gradeQuestion(qa[0], ["A"], 1, 0) === 0);
check("Unanswered is never negative", gradeQuestion(qa[0], [], 1, 0.25) === 0);
check("Wrong answer applies negative marking", gradeQuestion(qa[0], ["A"], 1, 0.25) === -0.25);
check("Multi: exact set scores full", gradeQuestion(qa[1], ["C", "A"], 1, 0) === 1);
check("Multi: partial set scores zero", gradeQuestion(qa[1], ["A"], 1, 0) === 0);
check("Multi: superset scores zero", gradeQuestion(qa[1], ["A", "B", "C"], 1, 0) === 0);

const attempt = gradeAttempt(qa, { "1": ["B"], "2": ["A"] }, 1, 0);
check("Attempt total adds up", attempt.score === 1 && attempt.maxScore === 2);
check("Correct count counts only full marks", attempt.correctCount === 1);
const empty = gradeAttempt(qa, {}, 1, 0.5);
check("Blank paper scores zero, not negative", empty.score === 0);

// --- roster ---------------------------------------------------------------
group("Roster parsing");
check("Splits on spaces, commas and newlines",
  eq(parseRoster("500098765, 500098766\n500098767  500098768"),
    ["500098765", "500098766", "500098767", "500098768"]));
check("Removes duplicates", parseRoster("5001 5001 5002").length === 2);
check("Empty input gives an empty roster", parseRoster("  \n ").length === 0);

// --- misc helpers ---------------------------------------------------------
group("Helpers");
check("safeId strips characters Firestore rejects", safeId("500/098 765") === "500_098_765");
check("Timer formats mm:ss", fmtTime(95) === "01:35");
check("Timer clamps negative time to 00:00", fmtTime(-5) === "00:00");
const src = [1, 2, 3, 4, 5];
const sh = shuffle(src);
check("shuffle does not mutate the source", eq(src, [1, 2, 3, 4, 5]));
check("shuffle keeps every element", eq([...sh].sort(), [1, 2, 3, 4, 5]));

// --- reading gate ---------------------------------------------------------
group("Compulsory reading time");
check("Defaults to 2 minutes when the quiz says nothing", readingSeconds({}) === 120);
check("Honours a quiz-specific reading time", readingSeconds({ readingMinutes: 3 }) === 180);
check("readingMinutes: 0 removes the gate", readingSeconds({ readingMinutes: 0 }) === 0);
check("A string value from a form input still works",
  readingSeconds({ readingMinutes: "7" }) === 420);
check("Nonsense values fall back to 2 minutes, never to 0",
  readingSeconds({ readingMinutes: "abc" }) === 120 &&
  readingSeconds({ readingMinutes: -4 }) === 120);
check("Fractional minutes are supported for a quick dry run",
  readingSeconds({ readingMinutes: 0.5 }) === 30);

// --- faculty-granted extra time -------------------------------------------
group("Resume after a disconnection");
check("No grant means the plain quiz duration",
  attemptMinutes({ durationMinutes: 20 }, { durationMinutes: 20 }) === 20);
check("Granted minutes are added to the attempt's own duration",
  attemptMinutes({ durationMinutes: 20 }, { durationMinutes: 20, extraMinutes: 7 }) === 27);
check("The attempt's stored duration wins over the quiz's current one",
  attemptMinutes({ durationMinutes: 45 }, { durationMinutes: 20 }) === 20);
check("Junk and negative grants are ignored",
  extraMinutes({ extraMinutes: "abc" }) === 0 &&
  extraMinutes({ extraMinutes: -5 }) === 0 &&
  extraMinutes({}) === 0);
check("A grant sent as a string from a prompt still counts",
  extraMinutes({ extraMinutes: "10" }) === 10);

// --- proctoring engine ----------------------------------------------------
group("Proctoring engine");
{
  let clock = 0;
  const seen = [];
  let limitFired = 0;
  const p = createProctor({
    maxViolations: 3,
    now: () => clock,
    doc: null, win: null,                      // no real listeners in the test
    onViolation: (c, kind, remaining) => seen.push({ c, kind, remaining }),
    onLimit: () => { limitFired++; },
  });

  p.report("tab/minimise");
  check("First violation is counted", p.count === 1);

  clock += 100;
  p.report("window focus lost");
  check("A second event from the same incident is ignored (debounce)", p.count === 1,
    `count became ${p.count}`);

  clock += VIOLATION_DEBOUNCE_MS + 1;
  p.report("left full screen");
  check("A genuinely new incident is counted", p.count === 2);
  check("Remaining count is reported to the UI", seen[1] && seen[1].remaining === 1);
  check("Limit has not fired early", limitFired === 0);

  clock += VIOLATION_DEBOUNCE_MS + 1;
  p.report("tab/minimise");
  check("Reaching the limit fires onLimit exactly once", limitFired === 1);
  check("onViolation is NOT also fired at the limit", seen.length === 2);

  clock += VIOLATION_DEBOUNCE_MS + 1;
  p.report("tab/minimise");
  check("No further violations are counted after the limit",
    p.count === 3 && limitFired === 1);
}

// --- keyboard blocking ----------------------------------------------------
group("Blocked shortcuts");
{
  const p = createProctor({ doc: null, win: null });
  const key = (k, mod = {}) => p.keyGuard({ key: k, preventDefault() { }, ...mod });
  check("F12 blocked", key("F12"));
  check("Ctrl+Shift+I blocked", key("I", { ctrlKey: true, shiftKey: true }));
  check("Ctrl+U (view source) blocked", key("u", { ctrlKey: true }));
  check("Ctrl+C blocked", key("c", { ctrlKey: true }));
  check("Cmd+C blocked on Mac", key("c", { metaKey: true }));
  check("Ctrl+P (print) blocked", key("p", { ctrlKey: true }));
  check("Ctrl+T (new tab) blocked", key("t", { ctrlKey: true }));
  check("Plain typing is NOT blocked", key("a") === false);
  check("Arrow keys are NOT blocked", key("ArrowDown") === false);
  check("Tab key is NOT blocked (keyboard navigation still works)", key("Tab") === false);
}

// --- attach/detach lifecycle ---------------------------------------------
group("Listener lifecycle");
{
  const added = [], removed = [];
  const fakeDoc = {
    hidden: false, fullscreenElement: null,
    addEventListener: (e) => added.push("doc:" + e),
    removeEventListener: (e) => removed.push("doc:" + e),
  };
  const fakeWin = {
    addEventListener: (e) => added.push("win:" + e),
    removeEventListener: (e) => removed.push("win:" + e),
  };
  const p = createProctor({ doc: fakeDoc, win: fakeWin });
  p.attach();
  check("attach() listens for visibilitychange", added.includes("doc:visibilitychange"));
  check("attach() listens for blur", added.includes("win:blur"));
  check("attach() listens for fullscreenchange", added.includes("doc:fullscreenchange"));
  check("attach() blocks copy/paste/contextmenu",
    added.includes("doc:copy") && added.includes("doc:paste") && added.includes("doc:contextmenu"));
  p.detach();
  check("detach() removes every listener it added", removed.length === added.length,
    `${added.length} added, ${removed.length} removed`);
  p.report("tab/minimise");
  check("No violations are recorded after detach (submitted attempts stay clean)",
    p.count === 0);
}

// --- per-student option order --------------------------------------------
group("Option shuffling (anti copy-from-neighbour)");
{
  const q = normalizeQuestions({
    questions: [{
      id: 5, question: "Q?",
      options: { A: "alpha", B: "bravo", C: "charlie", D: "delta" },
      correct_answer: "C",
    }],
  })[0];

  const a1 = displayOptions(q, "quiz__500001");
  const a2 = displayOptions(q, "quiz__500001");
  const b1 = displayOptions(q, "quiz__500002");

  check("Same student sees the same order on every render (resume-safe)",
    eq(a1.map((o) => o.key), a2.map((o) => o.key)));
  check("Every option survives the shuffle",
    eq([...a1.map((o) => o.key)].sort(), ["A", "B", "C", "D"]));
  check("Displayed labels are always A, B, C, D in position order",
    eq(a1.map((o) => o.label), ["A", "B", "C", "D"]));
  check("Each option keeps its ORIGINAL key, so grading is unaffected",
    a1.every((o) => q.options.find((x) => x.key === o.key).text === o.text));

  // Across many students the order must actually vary.
  const orders = new Set();
  for (let i = 0; i < 40; i++) {
    orders.add(displayOptions(q, `quiz__50${i}`).map((o) => o.key).join(""));
  }
  check("Different students get different option orders", orders.size > 5,
    `only ${orders.size} distinct orders in 40 students`);

  const fixedQ = normalizeQuestions({
    questions: [{
      id: 6, question: "Numeric?", shuffleOptions: false,
      options: { A: "1", B: "3", C: "9", D: "18" }, correct_answer: "D",
    }],
  })[0];
  check("shuffleOptions:false keeps the authored order (numeric/ordinal answers)",
    eq(displayOptions(fixedQ, "quiz__500001").map((o) => o.key), ["A", "B", "C", "D"]));
  check("The flag survives the public/key split",
    splitKey([fixedQ]).publicQuestions[0].shuffleOptions === false);

  check("seededShuffle is deterministic for a given seed",
    eq(seededShuffle([1, 2, 3, 4, 5], "x"), seededShuffle([1, 2, 3, 4, 5], "x")));
  check("seededShuffle does not mutate its input",
    eq((() => { const src = [1, 2, 3]; seededShuffle(src, "s"); return src; })(), [1, 2, 3]));
}

// --- the real quiz files --------------------------------------------------
const QUIZ_FILES = [
  ["Set A · CCVT", "../Research%20Methodology/Tests/CSEG3060_Quiz1_UnitI.json"],
  ["Set B · Full Stack AI", "../Research%20Methodology/Tests/CSEG3060_Quiz1_UnitI_FSAI.json"],
];
const loaded = {};

for (const [label, path] of QUIZ_FILES) {
  group(`Quiz 1 — ${label}`);
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const raw = await res.json();
    const qs = normalizeQuestions(raw);
    loaded[label] = qs;

    check("Loads and normalises to 25 questions", qs.length === 25,
      `got ${qs.length}`);
    check("Every question has exactly 4 options",
      qs.every((q) => q.options.length === 4));
    check("Every question has exactly one correct answer recorded",
      qs.every((q) => q.correct.length === 1));
    check("Every correct answer refers to an option that exists",
      qs.every((q) => q.options.some((o) => o.key === q.correct[0])));
    check("Every question carries an explanation for the post-quiz walkthrough",
      qs.every((q) => q.explanation && q.explanation.length > 40));
    check("Question ids are unique", new Set(qs.map((q) => q.id)).size === qs.length);
    check("All eight Unit I lectures are covered",
      new Set(qs.map((q) => q.topic.split(" — ")[0])).size === 8,
      [...new Set(qs.map((q) => q.topic.split(" — ")[0]))].join(" "));

    const { publicQuestions, correct, explanations } = splitKey(qs);
    const pub = JSON.stringify(publicQuestions);
    check("No answer key leaks into the student document",
      !pub.includes('"correct"') && publicQuestions.every((q) => !("correct" in q)));
    check("No explanation leaks into the student document",
      qs.every((q) => !pub.includes(q.explanation.slice(0, 40))));
    check("Key document covers all 25 questions", Object.keys(correct).length === 25);
    check("Explanations retained for faculty", Object.keys(explanations).length === 25);

    // A perfect paper and a blank paper, graded end to end.
    const perfect = {};
    qs.forEach((q) => { perfect[q.id] = q.correct.slice(); });
    const full = gradeAttempt(mergeKey(publicQuestions, correct), perfect, 0.4, 0);
    check("A perfect paper scores exactly 10 at 0.4/question",
      Math.abs(full.score - 10) < 1e-9 && full.correctCount === 25, `scored ${full.score}`);
    const blank = gradeAttempt(mergeKey(publicQuestions, correct), {}, 0.4, 0);
    check("A blank paper scores 0", blank.score === 0 && blank.maxScore === 10);

    check("At least 20 questions have their options reordered per student",
      qs.filter((q) => q.shuffleOptions !== false).length >= 20,
      `only ${qs.filter((q) => q.shuffleOptions !== false).length}`);

    const spread = {};
    qs.forEach((q) => { spread[q.correct[0]] = (spread[q.correct[0]] || 0) + 1; });
    document.getElementById("results").insertAdjacentHTML("beforeend",
      `<div class="t-row"><span class="st">INFO</span><span>${label}: authored key spread ` +
      `${JSON.stringify(spread)} — neutralised at run time by per-student option order.</span></div>`);
  } catch (e) {
    check(`${label} JSON loads`, false, e.message +
      " (serve the site over http — this check cannot run from file://)");
  }
}

// --- the two sets must not overlap ---------------------------------------
group("Set A vs Set B (different sittings, 25 and 26 August)");
{
  const a = loaded["Set A · CCVT"], b = loaded["Set B · Full Stack AI"];
  if (a && b) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const aq = new Set(a.map((q) => norm(q.question)));
    const shared = b.filter((q) => aq.has(norm(q.question)));
    check("No question text is reused between the two sets", shared.length === 0,
      `${shared.length} shared`);

    // Short options are shared technical vocabulary — "Internal", "External",
    // "Problem → Question" — which both sets must be free to use. Only longer
    // option prose would indicate a question was actually copied across.
    const LONG = 30;
    const aOpts = new Set(
      a.flatMap((q) => q.options.map((o) => norm(o.text))).filter((t) => t.length > LONG));
    const sharedOpts = b.flatMap((q) => q.options.map((o) => norm(o.text)))
      .filter((t) => t.length > LONG && aOpts.has(t));
    check("No option prose is copied between the sets", sharedOpts.length === 0,
      `${sharedOpts.length} shared: ${sharedOpts.slice(0, 2).join(" | ")}`);

    const count = (qs) => qs.reduce((m, q) => {
      const k = q.topic.split(" — ")[0]; m[k] = (m[k] || 0) + 1; return m;
    }, {});
    check("Both sets weight the eight lectures identically (fair across batches)",
      eq(count(a), count(b)), `${JSON.stringify(count(a))} vs ${JSON.stringify(count(b))}`);
  } else {
    check("Both quiz sets loaded for comparison", false, "one or both files missing");
  }
}

// --- summary --------------------------------------------------------------
const s = document.getElementById("summary");
s.className = "notice " + (fail === 0 ? "ok" : "err");
s.innerHTML = fail === 0
  ? `<b>All ${pass} checks passed.</b> Grading, answer-key separation, roster handling and the proctoring engine behave correctly on this machine.`
  : `<b>${fail} check(s) failed</b> out of ${pass + fail}. Do not run the quiz until these are fixed.`;
