export interface E2EPoolPlan {
    desktopExclusive: string[];
    parallelSafe: string[];
}

/**
 * Specs in this allowlist use only per-launch profiles, roots, logs, PTYs, and fake/blocked Agents.
 * Everything else remains `@desktop-exclusive` by default, especially native focus, clipboard,
 * Process Explorer, Screencast, performance, updater, and real-Agent coverage.
 */
export const parallelSafeSpecs = [
    'e2e/agent-icons.e2e.ts',
    'e2e/agent-login-path.e2e.ts',
    'e2e/agent-mode.e2e.ts',
    'e2e/chrome-tabs.e2e.ts',
    'e2e/editor-colors.e2e.ts',
    'e2e/editor-dotfiles.e2e.ts',
    'e2e/editor-find.e2e.ts',
    'e2e/editor-tabs.e2e.ts',
    'e2e/file-icons.e2e.ts',
    'e2e/file-tree-git-ignore.e2e.ts',
    'e2e/git-commits.e2e.ts',
    'e2e/git-pr.e2e.ts',
    'e2e/motion.e2e.ts',
    'e2e/path-browser.e2e.ts',
    'e2e/project-order.e2e.ts',
    'e2e/project-search.e2e.ts',
    'e2e/session-title.e2e.ts',
    'e2e/smoke.e2e.ts',
    'e2e/statusbar.e2e.ts',
    'e2e/terminal-layout.e2e.ts',
    'e2e/terminal-recovery.e2e.ts',
    'e2e/terminal-session-switch.e2e.ts',
    'e2e/workbench-recovery.e2e.ts',
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
    return {
        desktopExclusive: [...all].filter((path) => !safe.has(path)).sort(),
        parallelSafe: [...safe].sort(),
    };
}
