# Caxri evidence contract

Every Caxri Acceptance case names either the `desktop` or `mobile` surface and stores its artifacts
inside the current immutable round's `assets/` directory. A cross-device delivery may include both,
but each case belongs to the surface whose user outcome it asks the reviewer to decide.

## Evidence media

| Type           | Use when                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `screenshot`   | Settled desktop or device state, layout, styling, or visual hierarchy is the claim               |
| `dom_snapshot` | Desktop Renderer structure supports the visual observation                                       |
| `gif`          | A short transition or state change is the claim                                                  |
| `video`        | A longer interaction, streaming sequence, or multi-step flow needs continuous proof              |
| `text`         | Focused command output, sanitized receipts, or computed observations support non-visual behavior |
| `markdown`     | Structured reasoning or a concise human-readable analysis supports the observation               |

The `requiredEvidence` declaration is binding. A final screenshot cannot replace
a required temporal recording, and prose cannot replace a required screenshot.
The current LobeHub file ingest does not classify any extension as `transcript`.
Save transcript-like event-order evidence as `.txt` and declare it as `text`;
use `.md` or `.markdown` only when the declared type is `markdown`.
Save `dom_snapshot` evidence as `.html` or `.htm`. The interactive
`agent-browser snapshot -i` output supplies element references but is not the
report artifact; serialize the smallest relevant Renderer subtree by following
[agent-browser.md](agent-browser.md), then inspect the saved document.

## Artifact rules

- Reference artifacts from `cases[].evidence` with paths relative to the report
  directory, for example `assets/terminal-layout.png`.
- Every pass, fail, or blocked observation needs the evidence that supports that
  status.
- Inspect every image, clip, and generated document before citing it.
- Passing video evidence must survive the report finalizer's duration, frame-count,
  and visible-variation checks. A short or static frame sequence is not a recording.
- Never copy media from a blocked or failed round into a passing case. The finalizer
  compares immutable round history and rejects reused bytes, as well as one video
  attached to multiple passing cases.
- Never upload credentials, cookies, tokens, private user data, unrelated host
  windows, notifications, or a developer's resident Caxri state.
- Pairing links and QR payloads are credentials. Mobile raw accessibility trees can also contain
  Terminal previews, Session names, Project paths, keyboard suggestions, or pairing data; use
  Caxri's sanitized Android semantic/result receipts and review iOS hierarchy text before citing it.
- Never include a complete `caxri://` pairing URL, QR image, device credential, X25519 key, AES-GCM
  nonce, token, or secret-like value in evidence paths, files, observations, or `report.md`. Do not
  upload unfiltered ADB `logcat` or Simulator logs. Prefer allowlisted receipts; if private material
  entered a capture, invalidate it and rerun the isolated case instead of editing it into a pass.
- Capture mobile screenshots and recordings from the device framebuffer. Android Studio or
  Simulator host-window crops include unrelated chrome and do not prove native device pixels.
- Native sheets and app-modal windows are manual evidence by default. Do not capture or interact with
  them; hand the exact checklist to the user. The narrow exception in
  [native-dialogs.md](native-dialogs.md) requires an explicit current user request.
- Prefer a focused artifact over an unfiltered log or full-session recording.
- Reference the smallest sufficient evidence set. Do not attach reasoning and
  execution text for an interaction already proven by its focused recording and
  settled screenshot/DOM state; reserve the two-text-artifact protocol for
  genuinely non-visual claims.
- Retain source frames while a derived GIF or video is awaiting review.

## Non-visual behavior

When terminal, Runtime, IPC, persistence, or security behavior cannot be proven
by pixels alone, attach two separate `text` artifacts:

1. a concise reasoning artifact containing the claim, setup, method, expected
   result, interpretation, and limitation;
2. an execution artifact containing the exact command or interaction, relevant
   raw observations, exit or status values, and their mapping to the expectation.

For every mobile case, including `fail` and `blocked`, include the report-bound
`assets/<case-id>-mobile-device.json`; finalization checks its platform, app id, explicit device
identity, source commit, final lifecycle launch id, and `passed | failed | blocked` status against
the frozen case result. A `readonly_checkpoint` case carries its frozen checkpoint id instead of a
lifecycle launch id. A case blocked
before launch records the selected target and unavailable build identity without claiming the app
ran. For the guarded
Android reply case, the generated APK-hash/device receipt plus state-isolation
and bounded-result receipts are the execution evidence; do not add a raw Playwright trace or device
log. These artifacts
support the real selected product surface; they do not create another surface or replace required
visual/temporal evidence.
