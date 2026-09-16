// ---------------------------------------------------------------------------
// Proctoring engine
// ---------------------------------------------------------------------------
// Kept separate from student.js so it can be driven by quiz/selftest.html
// without touching Firestore. It owns exactly one thing: deciding when a
// student has left the assessment, and what happens next.
//
//   createProctor({ maxViolations, onViolation, onLimit })
//     .attach()          start listening (call when the quiz screen opens)
//     .detach()          stop listening (call on submit)
//     .report(kind)      register a violation manually / from a test
//     .count             violations so far
//
// Debouncing matters: leaving a window fires visibilitychange AND blur, and
// exiting full screen fires fullscreenchange too. One incident must count once.
// ---------------------------------------------------------------------------

export const VIOLATION_DEBOUNCE_MS = 1200;

export function createProctor(opts) {
  const {
    maxViolations = 3,
    onViolation = () => { },   // (count, kind, remaining)
    onLimit = () => { },       // (count, kind)  — fires once, at the limit
    doc: docRef = (typeof document !== "undefined" ? document : null),
    win = (typeof window !== "undefined" ? window : null),
    now = () => Date.now(),
  } = opts || {};

  let count = 0;
  let lastTs = -Infinity;
  let stopped = false;
  let limitReached = false;
  let handlers = [];

  const blockEvent = (e) => { e.preventDefault(); return false; };

  function on(target, evt, fn, capture) {
    if (!target) return;
    target.addEventListener(evt, fn, capture);
    handlers.push([target, evt, fn, capture]);
  }

  // Blocks the shortcuts that matter. Returns true when the key was blocked,
  // which is what the self-test asserts on.
  function keyGuard(e) {
    const k = String(e.key || "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const blocked = !!(
      e.key === "F12" ||
      (mod && e.shiftKey && ["i", "j", "c", "k"].includes(k)) ||
      (mod && ["c", "v", "x", "a", "p", "u", "s", "f", "t", "n", "w"].includes(k))
    );
    if (blocked && typeof e.preventDefault === "function") e.preventDefault();
    return blocked;
  }

  function report(kind) {
    if (stopped || limitReached) return null;
    const ts = now();
    if (ts - lastTs < VIOLATION_DEBOUNCE_MS) return null;   // same incident
    lastTs = ts;
    count += 1;

    const remaining = Math.max(0, maxViolations - count);
    if (count >= maxViolations) {
      limitReached = true;
      onLimit(count, kind);
    } else {
      onViolation(count, kind, remaining);
    }
    return { count, kind, remaining, at: ts };
  }

  function attach() {
    stopped = false;
    ["copy", "cut", "paste", "contextmenu", "selectstart", "dragstart"].forEach((evt) =>
      on(docRef, evt, blockEvent));
    on(docRef, "keydown", keyGuard, true);
    on(docRef, "visibilitychange", () => { if (docRef.hidden) report("tab/minimise"); });
    on(win, "blur", () => report("window focus lost"));
    on(docRef, "fullscreenchange", () => {
      if (!docRef.fullscreenElement) report("left full screen");
    });
    return api;
  }

  function detach() {
    stopped = true;
    handlers.forEach(([t, e, f, c]) => t && t.removeEventListener(e, f, c));
    handlers = [];
    return api;
  }

  const api = {
    attach, detach, report, keyGuard,
    get count() { return count; },
    get limitReached() { return limitReached; },
    set count(v) { count = v; },      // used when resuming an attempt
  };
  return api;
}

// Full-screen helpers — kept here so student.js has one place to call.
export async function goFullscreen(el) {
  const target = el || document.documentElement;
  try {
    if (target.requestFullscreen && !document.fullscreenElement) {
      await target.requestFullscreen({ navigationUI: "hide" });
      return true;
    }
  } catch (e) {
    console.warn("fullscreen request refused", e);
  }
  return !!document.fullscreenElement;
}

export function exitFullscreen() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
  } catch (e) { /* ignore */ }
}
