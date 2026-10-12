import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { getProcessIdentity, runCapture } from './process';
import type { StopOperations } from './worktree-processes';
import {
    defaultStopOperations,
    inspectWorktreeProcesses,
    parseProcessTable,
    stopProcesses,
    stopWorktreeProcesses,
} from './worktree-processes';

describe('stopping a real macOS process tree', () => {
    function writeExecutableScript(path: string, body: string): void {
        writeFileSync(path, `#!/bin/sh\n${body}`);
        chmodSync(path, 0o755);
    }

    /**
     * A three-level tree shaped like a detached Server Core (Server Core -> Extension Host -> a PTY shell), rooted
     * entirely under `root` so `isWorktreeOwnedCommand` claims it exactly as it would a real worktree, and matched only
     * through that path; nothing else on the machine can ever collide with it.
     */
    async function spawnServerTree(root: string, shouldIgnoreTerm: boolean): Promise<number> {
        const distribution = join(root, 'apps', 'server', 'dist');
        mkdirSync(distribution, { recursive: true });
        const shell = join(distribution, 'terminal-shell.sh');
        const extensionHost = join(distribution, 'extension-host.sh');
        const serverCore = join(distribution, 'server-core.sh');
        const trap = shouldIgnoreTerm ? "trap '' TERM\n" : '';
        writeExecutableScript(shell, `${trap}while true; do sleep 1; done\n`);
        writeExecutableScript(extensionHost, `${trap}"${shell}" &\nwhile true; do sleep 1; done\n`);
        writeExecutableScript(
            serverCore,
            `${trap}"${extensionHost}" &\nwhile true; do sleep 1; done\n`,
        );
        const child = spawn(serverCore, [], { cwd: root, detached: true, stdio: 'ignore' });
        child.unref();
        await waitForProcesses([serverCore, extensionHost, shell]);
        return child.pid!;
    }

    /**
     * Waits until every script of the tree is in the process table. A fixed sleep is not readiness: on a loaded CI
     * runner the nested forks can land after it, and `stop` then sees only the root.
     */
    async function waitForProcesses(
        scripts: readonly string[],
        deadline = Date.now() + 5_000,
    ): Promise<void> {
        const commands = parseProcessTable(
            await runCapture('ps', ['-axo', 'pid=,ppid=,command='], process.cwd()),
        ).map((entry) => entry.command);
        if (scripts.every((script) => commands.some((command) => command.includes(script)))) return;
        if (Date.now() > deadline)
            throw new Error(`Process tree did not start: ${scripts.join(', ')}`);
        await sleep(50);
        await waitForProcesses(scripts, deadline);
    }

    function makeRoot(): string {
        return mkdtempSync(join(tmpdir(), 'caxri-worktree-processes-test-'));
    }

    async function isPgrepStillMatching(root: string): Promise<boolean> {
        try {
            await runCapture('pgrep', ['-f', root], process.cwd());
            return true;
        } catch {
            // A non-zero pgrep exit (no match) surfaces as a thrown CommandError.
            return false;
        }
    }

    /**
     * Best-effort cleanup that signals only PIDs whose own command line carries this test's unique temporary root,
     * resolved one by one instead of handing a pattern to `pkill`.
     */
    async function killRootTree(root: string): Promise<void> {
        const entries = parseProcessTable(
            await runCapture('ps', ['-axo', 'pid=,ppid=,command='], process.cwd()),
        );
        for (const entry of entries) {
            if (!entry.command.includes(root)) continue;
            try {
                process.kill(entry.pid, 'SIGKILL');
            } catch {
                /*
                already gone
                */
            }
        }
    }

    it(
        'terminates a real responsive nested tree and reports it stopped, not merely signaled',
        { timeout: 15_000 },
        async () => {
            const root = makeRoot();
            try {
                const serverCorePid = await spawnServerTree(root, false);

                const result = await stopWorktreeProcesses(
                    { selfPid: process.pid, worktreePath: root },
                    defaultStopOperations,
                );

                expect(result.survivors).toEqual([]);
                expect(result.stopped.some((entry) => entry.pid === serverCorePid)).toBe(true);
                expect(result.stopped.length).toBeGreaterThanOrEqual(3);
                expect(await isPgrepStillMatching(root)).toBe(false);

                // Idempotent: nothing left to report, nothing left to signal.
                const second = await stopWorktreeProcesses(
                    { selfPid: process.pid, worktreePath: root },
                    defaultStopOperations,
                );
                expect(second.stopped).toEqual([]);
                expect(second.survivors).toEqual([]);
            } finally {
                await killRootTree(root);
                rmSync(root, { force: true, recursive: true });
            }
        },
    );

    it(
        'escalates through SIGKILL to clear a tree that ignores SIGTERM at every level',
        { timeout: 20_000 },
        async () => {
            const root = makeRoot();
            try {
                await spawnServerTree(root, true);

                const result = await stopWorktreeProcesses(
                    { selfPid: process.pid, worktreePath: root },
                    defaultStopOperations,
                );

                expect(result.survivors).toEqual([]);
                expect(await isPgrepStillMatching(root)).toBe(false);
            } finally {
                await killRootTree(root);
                rmSync(root, { force: true, recursive: true });
            }
        },
    );

    it('leaves a sibling worktree tree untouched', { timeout: 15_000 }, async () => {
        const root = makeRoot();
        const sibling = makeRoot();
        try {
            await spawnServerTree(root, false);
            const siblingPid = await spawnServerTree(sibling, false);

            await stopWorktreeProcesses(
                { selfPid: process.pid, worktreePath: root },
                defaultStopOperations,
            );

            expect(await isPgrepStillMatching(sibling)).toBe(true);
            expect(() => process.kill(siblingPid, 0)).not.toThrow();
        } finally {
            await killRootTree(root);
            await killRootTree(sibling);
            rmSync(root, { force: true, recursive: true });
            rmSync(sibling, { force: true, recursive: true });
        }
    });

    it(
        'refuses to signal a live PID once its real identity no longer matches the captured snapshot',
        { timeout: 15_000 },
        async () => {
            const root = makeRoot();
            try {
                const serverCorePid = await spawnServerTree(root, false);

                const before = await inspectWorktreeProcesses(
                    { selfPid: process.pid, worktreePath: root },
                    defaultStopOperations,
                );
                const captured = before.owned.find((entry) => entry.pid === serverCorePid)!;
                expect(captured.identity).toBeDefined();
                // Confirm the real identity actually matches the snapshot before poisoning it.
                expect(await getProcessIdentity(serverCorePid)).toBe(captured.identity);

                const signals: Array<[number, NodeJS.Signals]> = [];
                const spyOperations: StopOperations = {
                    ...defaultStopOperations,
                    signalProcess: (pid, signal) => {
                        signals.push([pid, signal]);
                        return defaultStopOperations.signalProcess(pid, signal);
                    },
                };
                const poisoned = { ...captured, identity: 'stale-identity-from-a-different-boot' };

                const result = await stopProcesses([poisoned], spyOperations);

                expect(signals).toEqual([]);
                expect(() => process.kill(serverCorePid, 0)).not.toThrow();
                expect(result.stopped.map(({ pid }) => pid)).toEqual([serverCorePid]);
            } finally {
                await killRootTree(root);
                rmSync(root, { force: true, recursive: true });
            }
        },
    );
});
