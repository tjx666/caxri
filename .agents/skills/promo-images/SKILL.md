---
name: promo-images
description: >
  Generate Caxri promotional images from a reusable scene: seed invented Projects, play scripted
  Claude Code and Codex Sessions in an isolated desktop app and a paired Android emulator, capture
  both, and compose them into a checked PNG. Use when creating or refreshing the README hero or
  another promo image (release, social, website), or when adding a promo scene or layout.
---

# Promo Images

A promo image is never a screenshot of the maintainer's own app: that would publish real Projects,
paths, Sessions, and account names. Every image comes from a **scene**: a JSON file describing
invented Projects, the Sessions to show, and the copy. The pipeline replays the scene from scratch
in an isolated profile, so a refreshed image is one command and every run looks the same.

| Scene                     | Output                        | Used by                |
| ------------------------- | ----------------------------- | ---------------------- |
| `scenes/readme-hero.json` | `docs/assets/readme-hero.png` | The top of `README.md` |

## Prerequisites

1. A fresh desktop build: `bun run build`. The capture refuses a stale build.
2. The release APK, rebuilt after mobile changes:
   `bun run --cwd apps/mobile prebuild:android -- --clean`, then
   `bun run --cwd apps/mobile android -- --build-only --variant release`.
3. The Chromium headless shell for composing: `bunx playwright install chromium-headless-shell`.
4. A disposable emulator on a free even port. The run reinstalls Caxri there and clears its data:

   ```sh
   nohup ~/Library/Android/sdk/emulator/emulator -avd Pixel_8 -port 5596 -read-only -wipe-data \
       -no-snapshot -no-audio -no-window > /tmp/emu-5596.log 2>&1 &
   ```

## Generate

```sh
bun run .agents/skills/promo-images/scripts/promo.ts \
    --scene .agents/skills/promo-images/scenes/readme-hero.json \
    --android-serial emulator-5596 --out docs/assets/readme-hero.png
```

`promo.ts` validates the scene, prepares the emulator (no animations, demo-mode status bar), runs
`promo-capture.pw.ts`, then composes with `promo-image.ts`. The capture and composition steps:

1. Seed each Project as a Git repository under `/tmp/caxri-promo-*` with an invented author and
   fixed dates, then apply its uncommitted `changes`.
2. Launch Caxri through the E2E launcher with scripted fake Agents (no real CLI, no model call),
   the scene's theme, and the window at `desktop` size and device scale 2.
3. Create every Session, select `desktop.session`, then play the others off-screen: the selected
   Session is marked read the moment it shows new attention, so its sidebar glyph would vanish.
   Wait for each expected state, mark `read` Sessions as read, pair the phone, and only then start
   `running` Sessions, because a held turn keeps the phone from idling.
4. Open `desktop.panel`, fold the waiting popup into the status bar, then capture the selected
   Session on the desktop and the Sessions list on the phone.
5. Compose the PNG. `--out` is replaced only when the new image passes its checks.

The captures, `layout.html`, and Playwright's output stay in `.records/promo-images/<scene>-<time>/`
(gitignored). Read the PNG and both captures after every run, and iterate on the scene until the
image reads well to a first-time visitor. `promo-compose.ts` recomposes existing captures when only
the copy or layout changed.

When finished, stop the emulator with `adb -s emulator-5596 emu kill` and confirm `adb devices`
no longer lists it. The capture closes its own Electron instance.

## Write a scene

The schema and its rules live in `scripts/promo-scene.ts`. The Agent turns live in the scripts
the scene names; their formats are documented in
`apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts` and
`fake-codex-script.ts`.

- Each Session's `prompt` must equal a scripted turn's prompt. `expect` needs a matching step:
  `waiting` an approval, `running` a hold, `failed` a fail step. Load errors name the field.
- Name hold files `promo-hold-<session>`. The fake Claude control directory also holds keyword
  files such as `hold-reply`, so a shorter name can collide.
- Seed `changes` so that they match the edits the Agents report. Source Control then agrees with
  the Chat, and the diff shows real line numbers.
- Use the real model names Caxri shows for current models, and invent everything else.
- In the hero layout the window bleeds off the bottom and the phone covers the window's right ~10%.
  Keep the content that tells the story in the top-left two thirds of the desktop capture.
- The hero backdrop uses Dracula tokens. Keep `theme` on `dracula` unless the layout changes too.

## Add a layout

Add the literal to `PromoLayoutInput['layout']` and the scene schema, add its plan beside
`planHero` in `promo-layout.ts`, and cover it in `promo-layout.test.ts`. Tag copy containers with
`data-promo-fit` and non-overlapping regions with `data-promo-apart`, so the renderer fails a
layout whose text is cut off or collides instead of writing the image.

## Before publishing

Call the Skill tool with "oss-confidentiality" and inspect the final PNG and both captures as an
anonymous visitor would. Check for real people, account or host names, home paths, private
repositories, and real Terminal or Agent output. Keep the emulator's real state out of the image:
the demo-mode status bar and the scene's `mobile.hostName` replace it. The capture hides the
desktop's remote-debugging status chip; if a new development-only indicator shows up in an
image, hide it in `hideDevelopmentChrome` rather than editing the image by hand.
