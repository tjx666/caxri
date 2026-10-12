import { describe, expect, it } from 'vitest';

import { checksWorktreeSetupCommands } from '../ci-checks-worktree-setup';

describe('checks worktree setup commands', () => {
    it('prepares lifecycle-free synthetic dependencies in executable order', () => {
        expect(checksWorktreeSetupCommands()).toEqual([
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
                arguments: ['exec', 'playwright', 'install', 'chromium-headless-shell'],
                command: 'pnpm',
                label: 'synthetic merge Playwright Chromium headless shell',
            },
        ]);
    });
});
