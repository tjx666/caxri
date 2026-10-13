/**
 * Dependency preparation for the synthetic-merge checks worktree that `scripts/ci-checks-worktree.ts` creates. The job
 * setup prepares the exact-head tree; these commands prepare the merge tree, whose dependencies may differ.
 */

interface ChecksWorktreeSetupCommand {
    arguments: string[];
    command: string;
    label: string;
}

export function checksWorktreeSetupCommands(): ChecksWorktreeSetupCommand[] {
    return [
        {
            arguments: [
                'install',
                '--frozen-lockfile',
                '--ignore-scripts',
                '--prefer-offline',
                '--no-runtime',
            ],
            command: 'pnpm',
            label: 'synthetic merge pnpm registry, unpack, and link',
        },
        {
            arguments: ['rebuild', 'electron'],
            command: 'pnpm',
            label: 'synthetic merge Electron download',
        },
        {
            arguments: ['run', 'scripts/prepare-node-pty.ts'],
            command: 'bun',
            label: 'synthetic merge node-pty spawn helper',
        },
        {
            /**
             * The job setup installs the headless shell for the exact-head Playwright version. When the base branch
             * upgraded Playwright after the PR branched, the synthetic merge resolves a newer browser build that the
             * runner cache does not hold, so browser-mode Vitest suites fail at launch (#1986). Installing from the
             * merge's own dependency tree is a no-op when both versions already match.
             */
            arguments: ['exec', 'playwright', 'install', 'chromium-headless-shell'],
            command: 'pnpm',
            label: 'synthetic merge Playwright Chromium headless shell',
        },
    ];
}
