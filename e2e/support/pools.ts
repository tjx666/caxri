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
 * Specs that request the protected clipboard capability. They remain desktop-exclusive, while the launch helper also
 * rejects the capability at runtime if a parallel-safe worker ever reaches one through a future classification edit.
 *
 * `scripts/__tests__/e2e-pools.test.ts` derives the same set from the specs themselves and fails when the two disagree.
 * That guard exists because this list silently fell three specs behind the source: a stale entry here does not fail
 * anything on its own, it just stops protecting the spec it forgot.
 */
export const clipboardCapabilitySpecs = [
    'e2e/bug-report.e2e.ts',
    'e2e/clipboard-restoration.e2e.ts',
    'e2e/editor-git-actions.e2e.ts',
    'e2e/file-operations.e2e.ts',
    'e2e/file-preview.e2e.ts',
    'e2e/path-browser.e2e.ts',
    'e2e/process-explorer-recovery.e2e.ts',
    'e2e/project-path-actions.e2e.ts',
    'e2e/settings.e2e.ts',
    'e2e/terminal-kitty-keyboard.e2e.ts',
    'e2e/terminal-long-paste.e2e.ts',
    'e2e/terminal-osc52-clipboard.e2e.ts',
    'e2e/terminal-search.e2e.ts',
    'e2e/terminal-selection.e2e.ts',
    'e2e/terminal-shortcuts.e2e.ts',
] as const;

/**
 * Specs in this allowlist use only per-launch profiles, roots, logs, PTYs, and fake/blocked Agents. Everything else
 * remains `@desktop-exclusive` by default, especially native focus, clipboard, Process Explorer, Screencast,
 * performance, updater, real-Agent coverage, and lifecycle-refresh assertions that are timing-sensitive while the
 * complete platform suite is saturating the same runner.
 *
 * Admitting a spec here is an individual audit, not a default. It must hold every condition below, because a
 * three-worker pool gives it neither an idle machine nor a private desktop:
 *
 * - No machine-global state: only the launch's own `userDataDir`, Project root, logs, and PTYs.
 * - No `clipboard` capability, `windowMode: 'visible'`, `gpuMode: 'enabled'`, `agentMode: { mode: 'real' }`, or packaged
 *   `executablePath`.
 * - No wall-clock assertion: a fixed delay window under test, a self-dismissing transient overlay, or a subprocess whose
 *   timeout has little headroom all lose their margin once three Electron workers share the runner. Virtual time
 *   through `page.clock` does not count as one.
 * - No machine-level process enumeration, native application menu, or system capture surface.
 *
 * Three specs pass a mechanical screen of those conditions and are still deliberately excluded, recorded here so the
 * audit is not repeated: `logs-panel.e2e.ts` asserts the panel's own query cadence in real milliseconds,
 * `menu-keybinding-recovery.e2e.ts` reads the installed native application menu, and `editor-find.e2e.ts` drives a
 * `cmd+k cmd+s` chord: a sibling worker's window taking real OS focus between the two keystrokes fires a genuine
 * `window` `blur` on this one, and `use-command-shortcuts.ts` deliberately cancels a pending chord on any blur (the
 * same class of contention `clickTerminalLink`'s JSDoc documents for Terminal link modifiers, issue caxri#697).
 * Confirmed by injecting a synthetic `blur` between the chord's two keystrokes locally: it reproduces the exact CI
 * signature (`Search keyboard shortcuts` never becoming visible within 15s) deterministically (issue caxri#1418).
 * `scripts/__tests__/e2e-pools.test.ts` holds a second, independent list of specs that must never be admitted; an audit
 * that reaches the opposite conclusion about one of them is a product decision, not a reclassification.
 *
 * `agent-delegation.e2e.ts` was previously rejected for the third condition and is now admitted, because the margin it
 * lacked was a defect rather than a property: its synthetic CLI allowed a `spawnSync` only 5 seconds beyond the
 * 20-second wait it was invoking. The rule excludes a timeout with little headroom: the right response is to give the
 * subprocess enough, not to keep the spec on one worker forever.
 */
export const parallelSafeSpecs = [
    'e2e/agent-actions.e2e.ts',
    'e2e/agent-activity.e2e.ts',
    'e2e/agent-commands.e2e.ts',
    'e2e/agent-delegation.e2e.ts',
    'e2e/agent-endpoint.e2e.ts',
    'e2e/agent-icons.e2e.ts',
    'e2e/agent-inbox.e2e.ts',
    'e2e/agent-login-path.e2e.ts',
    'e2e/agent-mode.e2e.ts',
    'e2e/agent-output-recovery.e2e.ts',
    'e2e/agent-skill.e2e.ts',
    'e2e/agent-terminal-title.e2e.ts',
    'e2e/agent-transcript-follow.e2e.ts',
    'e2e/caxri.e2e.ts',
    'e2e/chrome-tabs.e2e.ts',
    'e2e/codex-manual-resume.e2e.ts',
    'e2e/editor-action-slot.e2e.ts',
    'e2e/editor-breadcrumbs.e2e.ts',
    'e2e/editor-colors.e2e.ts',
    'e2e/editor-dotfiles.e2e.ts',
    'e2e/editor-split.e2e.ts',
    'e2e/editor-tabs.e2e.ts',
    'e2e/error-gate.e2e.ts',
    'e2e/error-toast-recovery.e2e.ts',
    'e2e/file-auto-reveal.e2e.ts',
    'e2e/file-icons.e2e.ts',
    'e2e/file-terminal-drag.e2e.ts',
    'e2e/file-tree-git-ignore.e2e.ts',
    'e2e/file-tree-sticky.e2e.ts',
    'e2e/git-commits.e2e.ts',
    'e2e/git-decoration-names.e2e.ts',
    'e2e/git-diff-excludes.e2e.ts',
    'e2e/git-diff-tabs.e2e.ts',
    'e2e/git-pr.e2e.ts',
    'e2e/git-submodule-refresh.e2e.ts',
    'e2e/grok-agent.e2e.ts',
    'e2e/hook-installation-authority.e2e.ts',
    'e2e/hook-turn-recovery.e2e.ts',
    'e2e/motion.e2e.ts',
    'e2e/pane-mixed-kind.e2e.ts',
    'e2e/picker-focus.e2e.ts',
    'e2e/pr-unknown.e2e.ts',
    'e2e/primary-sidebar-chrome.e2e.ts',
    'e2e/primary-sidebar-scroll.e2e.ts',
    'e2e/project-collapse.e2e.ts',
    'e2e/project-icons.e2e.ts',
    'e2e/project-order.e2e.ts',
    'e2e/project-search.e2e.ts',
    'e2e/session-archive.e2e.ts',
    'e2e/session-auto-naming.e2e.ts',
    'e2e/session-create-menu.e2e.ts',
    'e2e/session-external-editor.e2e.ts',
    'e2e/session-list-window.e2e.ts',
    'e2e/session-mru-switcher.e2e.ts',
    'e2e/session-navigation.e2e.ts',
    'e2e/session-order.e2e.ts',
    'e2e/session-pinning.e2e.ts',
    'e2e/session-pull-request.e2e.ts',
    'e2e/session-rename.e2e.ts',
    'e2e/session-restore-order.e2e.ts',
    'e2e/session-title.e2e.ts',
    'e2e/settings-parallel-safe.e2e.ts',
    'e2e/smoke.e2e.ts',
    'e2e/source-control-disclosure.e2e.ts',
    'e2e/source-control-keyboard-tree.e2e.ts',
    'e2e/source-control-row-tooltip.e2e.ts',
    'e2e/spinner-reduced-motion.e2e.ts',
    'e2e/status-external-fallback.e2e.ts',
    'e2e/status-shortcut.e2e.ts',
    'e2e/statusbar-stable-width.e2e.ts',
    'e2e/statusbar-width-parity.e2e.ts',
    'e2e/statusbar.e2e.ts',
    'e2e/terminal-codex-hard-wrap.e2e.ts',
    'e2e/terminal-color-query.e2e.ts',
    'e2e/terminal-commands.e2e.ts',
    'e2e/terminal-images.e2e.ts',
    'e2e/terminal-layout.e2e.ts',
    'e2e/terminal-link-hover.e2e.ts',
    'e2e/terminal-links.e2e.ts',
    'e2e/terminal-move.e2e.ts',
    'e2e/terminal-progress.e2e.ts',
    'e2e/terminal-prompt-isolation.e2e.ts',
    'e2e/terminal-recovery.e2e.ts',
    'e2e/terminal-reference-preview.e2e.ts',
    'e2e/terminal-session-switch.e2e.ts',
    'e2e/terminal-title.e2e.ts',
    'e2e/theme-presets.e2e.ts',
    'e2e/toasts.e2e.ts',
    'e2e/trusted-domains.e2e.ts',
    'e2e/view-badges.e2e.ts',
    'e2e/work-tab-sizing.e2e.ts',
    'e2e/workbench-terminal-lifetime.e2e.ts',
] as const;

export function createE2EPoolPlan(
    allSpecs: readonly string[],
    safeSpecs: readonly string[] = parallelSafeSpecs,
): E2EPoolPlan {
    const all = new Set(allSpecs);
    const safe = new Set<string>();
    for (const path of safeSpecs) {
        if (safe.has(path)) throw new Error(`Duplicate parallel-safe E2E spec: ${path}`);
        if (!all.has(path)) throw new Error(`Unknown parallel-safe E2E spec: ${path}`);
        safe.add(path);
    }
    const parallelSafe = [...safe].toSorted((a, b) => a.localeCompare(b));
    const desktopExclusive = [...all]
        .filter((path) => !safe.has(path))
        .toSorted((a, b) => a.localeCompare(b));

    return {
        desktopExclusive,
        desktopExclusiveInvocations:
            desktopExclusive.length > 0 ? [{ specs: desktopExclusive }] : [],
        parallelSafe,
        parallelSafeInvocations: parallelSafe.length > 0 ? [{ specs: parallelSafe }] : [],
    };
}
