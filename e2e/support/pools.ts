export interface E2EPoolInvocation {
    specs: string[];
}

export interface E2EPoolPlan {
    desktopExclusive: string[];
    desktopExclusiveInvocations: E2EPoolInvocation[];
    parallelSafe: string[];
    parallelSafeInvocations: E2EPoolInvocation[];
}

/**
 * Why a spec cannot share the runner with the three-worker `parallel-safe` pool. The set is closed so a reason has to
 * name a concrete property of the spec, not a general unease; `scripts/__tests__/e2e-pools.test.ts` derives the first
 * three from the spec sources and fails when an entry and its source disagree in either direction.
 *
 * - `clipboard`: requests the machine-global pasteboard (`clipboard: true`).
 * - `visible-window`: launches with `windowMode: 'visible'`, which takes real OS focus from sibling workers.
 * - `gpu`: launches with `gpuMode: 'enabled'`.
 * - `window-focus`: depends on this window holding OS focus, such as a two-keystroke chord a sibling window's focus
 *   cancels, or Session attention that `document.hasFocus()` acknowledges.
 * - `wall-clock`: asserts real elapsed time, races a production timer, or must observe a self-dismissing surface inside
 *   its real-time lifetime.
 * - `load-sensitive`: a lifecycle or recovery workflow that a prior audit found unreliable on a saturated runner.
 * - `machine-process`: enumerates machine processes or drives a Server Core outside the launch helper's ownership.
 * - `native-menu`: reads the installed native application menu as the OS presents it.
 * - `screen-capture`: uses a system capture surface.
 * - `benchmark`: a performance measurement that needs an otherwise idle machine.
 * - `opt-in-only`: skipped in both pools; a dedicated script or manual workflow runs it.
 */
export type DesktopExclusiveReason =
    | 'benchmark'
    | 'clipboard'
    | 'gpu'
    | 'load-sensitive'
    | 'machine-process'
    | 'native-menu'
    | 'opt-in-only'
    | 'screen-capture'
    | 'visible-window'
    | 'wall-clock'
    | 'window-focus';

export interface DesktopExclusiveClassification {
    reasons: readonly [DesktopExclusiveReason, ...DesktopExclusiveReason[]];
    /**
     * The concrete evidence, specific enough that the next audit can check it against the spec without repeating it.
     */
    why: string;
}

/**
 * Every spec not listed here runs in the three-worker `parallel-safe` pool. Before issue #1846 the default was the
 * opposite: an unlisted spec silently joined the one-worker pool, which grew from 137 to 155 tests in a few days and
 * pushed the full run past its 25-minute deadline. A new spec now earns the exclusive pool by naming its reason.
 *
 * The parallel pool gives a spec neither an idle machine nor a private desktop: three Electron workers share the
 * runner, each with its own launch `userDataDir`, Project root, logs, and PTYs, and any sibling window can take OS
 * focus at any moment. A spec belongs here when it holds machine-global state, needs OS focus or a visible window,
 * asserts wall-clock time (virtual time through `page.clock` does not count), enumerates machine processes, or reads a
 * system surface. The launch helper also rejects the mechanical cases at runtime inside the parallel pool (`clipboard:
 * true`, `windowMode: 'visible'`, `gpuMode: 'enabled'`), so a forgotten entry fails on its first run instead of
 * flaking.
 *
 * Some audits are worth keeping because their conclusion is not visible in the source: `editor-find.e2e.ts` drives a
 * `cmd+k cmd+s` chord that `use-command-shortcuts.ts` deliberately cancels on any window `blur`, and injecting a
 * synthetic blur between the keystrokes reproduces its CI signature deterministically (issue caxri#1418). Specs that
 * use `clickTerminalLink` stay admissible: that helper re-arms the Cmd modifier a sibling's focus dropped (issue
 * caxri#697). `scripts/__tests__/e2e-pools.test.ts` pins specs that must stay here; reaching the opposite conclusion
 * about one of them is a product decision, not a reclassification.
 */
export const desktopExclusiveSpecs: Readonly<Record<string, DesktopExclusiveClassification>> = {
    'e2e/agent-commander-inbox-chip.e2e.ts': {
        reasons: ['window-focus'],
        why: 'Asserts the first Inbox item is focused after the chip brings Commander forward; toBeFocused() needs the Commander document to hold OS focus.',
    },
    'e2e/agent-commander-inbox.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Clicks Undo on the "Dismissed" toast before its real 4s auto-dismissal sends the dismissal.',
    },
    'e2e/agent-chat-switch.performance.e2e.ts': {
        reasons: ['benchmark', 'opt-in-only'],
        why: 'Agent Chat Session-switch benchmark; skipped outside its benchmark command.',
    },
    'e2e/agent-chat-background.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Clicks Undo on the "Queued message removed" toast before its real 4s auto-dismissal.',
    },
    'e2e/agent-chat-turn-review.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Clicks Undo on the "Comment removed" toast before its real 4s auto-dismissal.',
    },
    'e2e/agent-chat-claude.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Asserts an approved command row shows no duration, i.e. the approval round trip stays under one real second.',
    },

    'e2e/agent-chat.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Asserts an approved command row shows no duration, i.e. the approval round trip stays under one real second.',
    },
    'e2e/agent-chat-selection.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Asserts the "Selection copied" toast before its real 4s auto-dismissal.',
    },
    'e2e/agent-chat-surface-switch.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/agent-notifications.e2e.ts': {
        reasons: ['visible-window', 'window-focus', 'wall-clock'],
        why: 'A notification click calls app.focus({ steal: true }); the hidden case waits 2.5s against a 2s Server refresh.',
    },
    'e2e/bug-report.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/clipboard-restoration.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/codex-compaction.e2e.ts': {
        reasons: ['load-sensitive'],
        why: 'Compaction lifecycle refresh; pinned by a prior audit.',
    },
    'e2e/codex-running-watchdog.e2e.ts': {
        reasons: ['visible-window', 'window-focus'],
        why: 'Expects the selected Session to acknowledge attention, which needs a visible, focused document.',
    },
    'e2e/desktop-server.e2e.ts': {
        reasons: ['visible-window', 'machine-process'],
        why: 'Kills and reconnects Server Core across Desktop generations and asserts window focus.',
    },
    'e2e/editor-find.e2e.ts': {
        reasons: ['window-focus'],
        why: 'A cmd+k cmd+s chord that any window blur cancels (issue caxri#1418).',
    },
    'e2e/editor-fold-on-open.e2e.ts': {
        reasons: ['window-focus', 'wall-clock'],
        why: 'A Monaco cmd+k cmd+j chord, then asserts no refold happens within a real 2s window.',
    },
    'e2e/editor-git-actions.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/editor.performance.e2e.ts': {
        reasons: ['benchmark', 'opt-in-only'],
        why: 'Editor performance benchmark; skipped outside its benchmark command.',
    },
    'e2e/extensions.e2e.ts': {
        reasons: ['load-sensitive'],
        why: 'Extension Host crash and restore recovery; pinned by a prior audit.',
    },
    'e2e/failure-isolation.e2e.ts': {
        reasons: ['opt-in-only'],
        why: 'Runs only through scripts/run-e2e-failure-isolation.ts.',
    },
    'e2e/file-operations.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/file-preview.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/logs-panel.e2e.ts': {
        reasons: ['wall-clock'],
        why: "Asserts the panel's own query cadence in real milliseconds.",
    },
    'e2e/menu-keybinding-recovery.e2e.ts': {
        reasons: ['native-menu'],
        why: 'Reads accelerators from the installed native application menu.',
    },
    'e2e/mobile-acceptance-scenarios.e2e.ts': {
        reasons: ['opt-in-only'],
        why: 'Mobile Acceptance fixture; skipped outside its Acceptance workflow.',
    },
    'e2e/mobile-dashboard-parity.e2e.ts': {
        reasons: ['opt-in-only'],
        why: 'Mobile parity fixture; skipped outside its Acceptance workflow.',
    },
    'e2e/mobile-pairing-desktop-acceptance.e2e.ts': {
        reasons: ['opt-in-only'],
        why: 'Mobile pairing fixture; skipped outside its Acceptance workflow.',
    },
    'e2e/path-browser.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/performance-monitor.e2e.ts': {
        reasons: ['visible-window', 'machine-process'],
        why: 'The detached monitor is its own visible window and reads machine process metrics.',
    },
    'e2e/process-explorer-recovery.e2e.ts': {
        reasons: ['clipboard', 'machine-process'],
        why: 'Process Explorer lists machine processes and copies details through the pasteboard.',
    },
    'e2e/process-explorer.e2e.ts': {
        reasons: ['visible-window', 'machine-process'],
        why: 'Process Explorer lists machine processes in its own visible window.',
    },
    'e2e/project-path-actions.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/real-agent-smoke.e2e.ts': {
        reasons: ['opt-in-only'],
        why: 'Manual real Codex smoke; skipped unless bun run test:e2e:real-agent enables it.',
    },
    'e2e/renderer.performance.e2e.ts': {
        reasons: ['benchmark', 'visible-window', 'opt-in-only'],
        why: 'Renderer performance gate; skipped outside its benchmark step.',
    },
    'e2e/screencast.e2e.ts': {
        reasons: ['screen-capture'],
        why: 'Drives the Screencast capture surface.',
    },
    'e2e/server-platform.e2e.ts': {
        reasons: ['machine-process'],
        why: 'Starts and restarts an app-managed Server Core outside the launch helper; pinned by a prior audit.',
    },
    'e2e/session-attention.e2e.ts': {
        reasons: ['visible-window', 'window-focus', 'machine-process'],
        why: 'Attention acknowledgement needs a visible, focused document; also inspects Process Explorer.',
    },
    'e2e/session-compaction.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Three assertions on the batch-compaction result toast before its real 4s auto-dismissal.',
    },
    'e2e/session-rename-pending.e2e.ts': {
        reasons: ['wall-clock'],
        why: "1s assertions and a not-yet-renamed check race the fake Agent's real 4s timer.",
    },
    'e2e/session-return-restart.e2e.ts': {
        reasons: ['visible-window', 'window-focus'],
        why: 'Server Core records the last viewed boundary only while a visible window holds OS focus.',
    },
    'e2e/session-title-scroll.e2e.ts': {
        reasons: ['wall-clock'],
        why: 'Samples marquee speed with performance.now() and asserts motion windows of 500ms to 2.5s.',
    },
    'e2e/settings.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/source-control-keyboard-tree.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/startup.performance.e2e.ts': {
        reasons: ['benchmark', 'opt-in-only'],
        why: 'Startup benchmark; skipped outside its benchmark command.',
    },
    'e2e/terminal-kitty-keyboard.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/terminal-long-paste.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/terminal-osc52-clipboard.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/terminal-search.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/terminal-selection.e2e.ts': {
        reasons: ['clipboard', 'visible-window'],
        why: 'Copies Terminal selections through the pasteboard in a visible window.',
    },
    'e2e/terminal-shortcuts.e2e.ts': {
        reasons: ['clipboard'],
        why: 'Requests the system pasteboard (clipboard: true).',
    },
    'e2e/terminal-webgl.e2e.ts': {
        reasons: ['gpu'],
        why: 'Exercises the WebGL renderer with the GPU enabled.',
    },
    'e2e/updates.e2e.ts': {
        reasons: ['load-sensitive'],
        why: 'Packaged-only update workflow; pinned by a prior audit.',
    },
    'e2e/window-mode.e2e.ts': {
        reasons: ['visible-window'],
        why: 'Asserts the hidden and visible window modes themselves.',
    },
    'e2e/workbench-recovery.e2e.ts': {
        reasons: ['load-sensitive'],
        why: 'Complete workbench recovery and persistence workflow; pinned by a prior audit.',
    },
    'e2e/workbench-root.e2e.ts': {
        reasons: ['load-sensitive'],
        why: 'Hook attribution and worktree lifecycle refresh that failed on a saturated runner; pinned by a prior audit.',
    },
};

export function createE2EPoolPlan(
    allSpecs: readonly string[],
    exclusiveSpecs: readonly string[] = Object.keys(desktopExclusiveSpecs),
): E2EPoolPlan {
    const all = new Set(allSpecs);
    const exclusive = new Set<string>();
    for (const path of exclusiveSpecs) {
        if (exclusive.has(path)) throw new Error(`Duplicate desktop-exclusive E2E spec: ${path}`);
        // A stale entry would otherwise outlive its spec and hide that the classification list drifted.
        if (!all.has(path)) throw new Error(`Unknown desktop-exclusive E2E spec: ${path}`);
        exclusive.add(path);
    }
    const desktopExclusive = [...exclusive].toSorted((a, b) => a.localeCompare(b));
    const parallelSafe = [...all]
        .filter((path) => !exclusive.has(path))
        .toSorted((a, b) => a.localeCompare(b));

    return {
        desktopExclusive,
        desktopExclusiveInvocations:
            desktopExclusive.length > 0 ? [{ specs: desktopExclusive }] : [],
        parallelSafe,
        parallelSafeInvocations: parallelSafe.length > 0 ? [{ specs: parallelSafe }] : [],
    };
}
