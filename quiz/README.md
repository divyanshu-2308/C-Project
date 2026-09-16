# Online Quiz System (proctored)

A proctored MCQ quiz that runs on this static site (GitHub Pages) with **Firebase
Firestore** as the backend, so the faculty dashboard sees every student live.

## What protects the quiz

| Layer | What it does |
|---|---|
| **Full-screen lock** | The quiz only starts in full screen. Leaving full screen is detected instantly. |
| **Focus enforcement** | Tab switch, app switch, minimise and window-blur each raise a **violation**: a blocking overlay covers the paper, the count goes up, and the event is timestamped in Firestore. |
| **Auto-submit** | On the *n*-th violation (default 3) the attempt is submitted automatically with whatever is answered. |
| **Screen blanking** | The paper is blurred the instant focus is lost, so a screenshot or screen-share taken while switching away captures nothing. |
| **Answer key never leaves the server** | Students receive questions **without** correct answers. Grading happens in the faculty dashboard after the quiz. |
| **Score cannot be self-written** | Firestore rules forbid a student's browser from writing `score`, `graded` or another student's document. |
| **Roster restriction** | Only SAP IDs you upload can start. Everyone else is refused by the rules. |
| **Server clock** | The countdown is derived from Firestore's server timestamp and re-synced during the quiz, so changing the device clock does not buy time. |
| **Reliability** | Autosave on every answer + a 20 s heartbeat, retry-with-backoff on every write, resume after refresh/disconnect with the original time remaining, and a downloadable signed receipt if submission ever fails. |
| **Faculty rescue** | A student who is knocked offline can be put back into the quiz from the dashboard — on any device, with extra minutes to cover the time they lost — or have their attempt closed for grading as it stands. |
| **Input blocking** | Copy, cut, paste, right-click, text selection, drag, printing, F12, Ctrl+Shift+I/J/C, Ctrl+U/S/P/F, Ctrl+T/N/W. |

### What it honestly cannot do

Read this before you rely on it:

- **A second device.** A phone beside the laptop is invisible to the browser. Nothing
  in a web page can see it.
- **Another person in the room**, or a screen-share to a friend on a different machine.
- **Truly preventing** the student from leaving full screen. The browser will not let a
  page trap the user — we can only *detect* the exit and react, which is what we do.
- **Preventing a determined student from reading the questions' HTML.** Questions are
  necessarily in the browser; only the *answers* are protected.
- **Proving identity.** The roster stops an unenrolled ID being used, but not a
  classmate typing an enrolled one. Physical invigilation still matters.

Treat the violation count as **evidence for a conversation**, not automatic proof of
cheating — laptops raise notifications, and a legitimate student can lose focus once.

---

## One-time setup

1. **Firestore** — Firebase console → Build → *Firestore Database* → create (production mode).
2. **Auth** — Build → *Authentication* → *Sign-in method*:
   - enable **Anonymous** (students)
   - enable **Email/Password** (faculty)
   Then *Users* → **Add user** → create your own faculty account.
3. Put that faculty email in **`ADMIN_EMAILS`** in [`firebase-config.js`](firebase-config.js)
   **and** in the rules below (both places, identical).
4. **Rules** — Firestore → *Rules* → paste the block below → **Publish**.

### Firestore security rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isAdmin() {
      return request.auth != null
             && request.auth.token.email in ['mohsin.dar@ddn.upes.ac.in'];
    }

    // Roster check, read server-side. Students never see this document.
    function onRoster(quizId, sapId) {
      return exists(/databases/$(database)/documents/quizKeys/$(quizId))
             && get(/databases/$(database)/documents/quizKeys/$(quizId))
                  .data.roster.hasAny([sapId]);
    }

    // Public quiz: questions WITHOUT correct answers.
    match /quizzes/{quizId} {
      allow read:  if request.auth != null;
      allow write: if isAdmin();
    }

    // Answer key + roster. Faculty only — never readable by a student.
    match /quizKeys/{quizId} {
      allow read, write: if isAdmin();
    }

    match /attempts/{attemptId} {
      // Faculty pressed "Allow resume" for a student who dropped off the
      // network. While this flag is set — and only while it is set — a browser
      // other than the one that started the attempt may open it.
      function resumeOpen() {
        return resource.data.get('resumeAllowed', false) == true;
      }

      // A student may read only their own attempt; faculty read everything.
      // `resource == null` must come first: a student starting a fresh attempt
      // reads a document that does not exist yet, and without this clause that
      // read is denied — which looks like "someone else already started".
      allow get: if isAdmin()
                 || resource == null
                 || (request.auth != null && resource.data.uid == request.auth.uid)
                 || (request.auth != null && resumeOpen());

      // Only faculty may list/query the collection. Students never need to.
      allow list: if isAdmin();

      // Starting an attempt: must be on the roster, must be tied to this browser,
      // must start unscored and in progress.
      allow create: if request.auth != null
                    && request.resource.data.uid == request.auth.uid
                    && request.resource.data.status == 'in-progress'
                    && request.resource.data.score == null
                    && request.resource.data.graded == false
                    && request.resource.data.violations == 0
                    && onRoster(request.resource.data.quizId,
                                request.resource.data.sapId);

      // Taking over a granted resume: the ONLY way a different browser can
      // claim an attempt. It works exactly once — the same write spends the
      // grant — and it can change nothing except who owns the attempt.
      function claimResume() {
        return request.auth != null
               && resumeOpen()
               && resource.data.status == 'in-progress'
               && request.resource.data.uid == request.auth.uid
               && request.resource.data.resumeAllowed == false
               && request.resource.data.diff(resource.data).affectedKeys()
                    .hasOnly(['uid', 'resumeAllowed', 'lastSeenAt']);
      }

      // During/at the end of an attempt the student may only touch these fields,
      // may never score themselves, and may never reopen a submitted attempt.
      allow update: if isAdmin()
                    || claimResume()
                    || (request.auth != null
                        && resource.data.uid == request.auth.uid
                        && resource.data.status == 'in-progress'
                        && request.resource.data.uid == resource.data.uid
                        && request.resource.data.sapId == resource.data.sapId
                        && request.resource.data.startedAt == resource.data.startedAt
                        && request.resource.data.score == null
                        && request.resource.data.graded == false
                        && request.resource.data.violations >= resource.data.violations
                        && request.resource.data.status in ['in-progress', 'submitted']
                        && request.resource.data.diff(resource.data).affectedKeys()
                             .hasOnly(['answers', 'order', 'violations', 'violationLog',
                                       'lastSeenAt', 'status', 'submittedAt',
                                       'autoSubmitted', 'submitReason']));

      allow delete: if isAdmin();
    }
  }
}
```

The email in `isAdmin()` **must be identical** to the one in `ADMIN_EMAILS` in
[`firebase-config.js`](firebase-config.js), and an account with that exact address must
exist under Firebase → Authentication → Users. Note what the update rule enforces: a student can add answers and *increase* their violation count,
but cannot decrease it, cannot write a score, cannot alter their start time, and cannot
edit an attempt after it is submitted. Extra time (`extraMinutes`) and the resume grant
(`resumeAllowed`) are outside the list a student may write, so only the dashboard can
issue them — and a granted resume is spent by the first browser that claims it.

> **Re-publish the rules** if your project is still running the earlier version: without
> `resumeOpen()` and `claimResume()`, **Allow resume** works only when the student comes
> back on the same browser they started in.

---

## Running a quiz

**Before the class**

1. Open `quiz/admin.html`, sign in.
2. Upload the questions JSON, set duration / marks / negative marks / violations allowed /
   reading time (the compulsory instructions screen, **2 minutes** by default; `0` removes it).
3. Paste the **roster** of SAP IDs (or upload a `.txt`/`.csv`). Saving is blocked without one.
4. Leave status **Draft**. Save. Verify the quiz appears in the monitor dropdown.

**In the class**

5. Change status to **Active** and save (or flip `active` in the Firestore console).
6. Tell students: laptop only, close other apps, stable network, and that leaving the
   window three times ends the attempt.
7. Keep the dashboard open. Watch the **Violations** and **Live** columns — "stale" means
   a student's browser has not checked in for a minute (crash, sleep or disconnection).

**When a student drops out mid-quiz**

The **Action** column on that student's row gives you the two ways out. Their answers are
already on the server — every answer is saved as it is ticked — so nothing is lost either way.

| Button | What it does |
|---|---|
| **Allow resume** | Puts the attempt back in play. You are asked how many **extra minutes** to grant (pre-filled with the time they lost while away); the deadline moves by that much. The student signs in again with the same SAP ID — **on any device**, not just the one that crashed — and carries on from their saved answers, with their violation count intact. The row reads **resume open** until they are back. |
| **Force submit** | Closes the attempt as it stands, so it can be graded. Marked `faculty` in the submit-reason column and the CSV. If that browser is somehow still running, it is shown "Attempt closed" at its next check-in. |

**Reopen** does the same as Allow resume for an attempt that is already submitted — use it
when a disconnection caused an automatic proctoring submit. Any score it had is cleared, so
run **Grade all attempts** again afterwards.

Two things to know:

- Grant the resume **before** you press *Close quiz*. A closed quiz is not listed on the
  student page, so they cannot get back to it.
- While a resume is open, the roster is still enforced but the identity check is not — the
  next person to sign in with that SAP ID takes the attempt. Grant it when the student is
  in front of you.

**After**

8. Press **Close quiz** so late arrivals cannot start.
9. Press **Grade all attempts** — this reads the answer key, grades every *submitted*
   attempt and writes the scores.
10. **Export CSV** — the marks sheet: each violation with its kind and timestamp, answered
    count, score, extra minutes granted, and the true elapsed time from server timestamps.
11. **Download all attempts** — the papers themselves, as **one** self-contained HTML file:
    a summary table, a question-by-question breakdown of how the class did (attempted,
    % correct, most-chosen options), then every student's full answer sheet — each question
    with the options **in the order that student saw them**, their pick and the correct one
    marked, and the explanation. It opens in any browser with no network, and printing it
    gives one student per page. Run **Grade all attempts** first if you want the stored
    scores to agree with it.

    The file contains the answer key and the explanations — it is a **faculty copy**, not
    something to hand back as it is.

If a student's submission failed (rare — they will show a red "Submission not confirmed"
panel), they can download a JSON receipt with their answers. Grade it manually.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` / `student.js` | Student sign-in, proctored quiz runner, submission |
| `admin.html` / `admin.js` | Faculty: create quizzes, roster, live monitor, grading, CSV |
| `common.js` | Normalisation, answer-key split/merge, grading, roster parsing |
| `firebase-config.js` | Firebase keys, faculty allow-list, auth helpers |
| `styles.css` | Styling, including the proctor overlay and blur |

## Data model

```
quizzes/{quizId}    public   { title, durationMinutes, marksPerQuestion, negativeMarks,
                               maxViolations, active, shuffle, questions[] }   ← no answers
quizKeys/{quizId}   faculty  { correct: { qid: [keys] }, roster: [sapId, ...] }
attempts/{quizId__sapId}     { uid, name, sapId, status, startedAt, submittedAt,
                               lastSeenAt, answers, order, violations, violationLog[],
                               score, graded, autoSubmitted, submitReason,
                               extraMinutes, resumeAllowed, resumeGrantedAt }  ← faculty-set
```
