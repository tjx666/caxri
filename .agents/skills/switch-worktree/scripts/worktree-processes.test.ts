import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { runCapture } from './process';
import type { ProcessEntry, StopOperations } from './worktree-processes';
import {
    defaultStopOperations,
    findOrphanedProcesses,
    isWorktreeOwnedCommand,
    parseProcessTable,
    stopProcesses,
    stopWorktreeProcesses,
    worktreeProcessesToStop,
} from './worktree-processes';

const WORKTREE = '/Users/me/code/caxri-worktrees/fix-example-1a2b3c4d';

/**
 * Shapes taken from a real `ps -axo pid=,ppid=,command=` on macOS: an installed production app, an unrelated Electron
 * app, a sibling worktree, this worktree's dev launcher subtree, its detached Server Core, and the agent shell that
 * would be running `stop` itself.
 */
const TABLE = [
    `  501     1 /Applications/Caxri.app/Contents/MacOS/Caxri`,
    `  502   501 /Applications/Caxri.app/Contents/Frameworks/Caxri Helper (Renderer).app/Contents/MacOS/Caxri Helper (Renderer) --type=renderer`,
    `  503     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron ${WORKTREE}`,
    `  504     1 /Users/me/code/caxri-worktrees/fix-other-9z8y7x6w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
    `  599     1 /Users/me/.bun/bin/bun run dev`,
    `  600   599 ${WORKTREE}/node_modules/.bin/electron-vite dev`,
    `  601   600 Caxri Dev`,
    `  602   601 Caxri Dev Helper (Renderer) --type=renderer`,
    `  603     1 /opt/homebrew/bin/node ${WORKTREE}/apps/server/dist/server/bundles/server-core.js`,
    `  604     1 ${WORKTREE}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --remote-debugging-port=0`,
    `  700     1 /bin/zsh -lc cd ${WORKTREE} && bun run stop`,
    `  701   700 /Users/me/.bun/bin/bun run ${WORKTREE}/.agents/skills/switch-worktree/scripts/switch-worktree.ts stop`,
].join('\n');

function entries(): ProcessEntry[] {
    return parseProcessTable(TABLE);
}

function stoppedIds(launcherPid?: number): number[] {
    return worktreeProcessesToStop({
        entries: entries(),
        ...(launcherPid !== undefined && { launcherPid }),
        selfPid: 701,
        worktreePath: WORKTREE,
    })
        .map((entry) => entry.pid)
        .toSorted((left, right) => left - right);
}

describe('worktree process ownership', () => {
    it('runs process-table commands with a stable locale', async () => {
        vi.stubEnv('LC_ALL', 'zh_CN.UTF-8');
        try {
            expect((await runCapture('printenv', ['LC_ALL'], process.cwd())).trim()).toBe('C');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('keeps the two leading columns apart from command lines that contain spaces', () => {
        const helper = parseProcessTable(TABLE).find((entry) => entry.pid === 502);

        expect(helper).toEqual({
            command:
                '/Applications/Caxri.app/Contents/Frameworks/Caxri Helper (Renderer).app/Contents/MacOS/Caxri Helper (Renderer) --type=renderer',
            parentPid: 501,
            pid: 502,
        });
    });

    it('captures start time and command as the process identity in the same listing', () => {
        const identityText = 'Thu Sep 24 00:00:00 2026     Caxri Dev';
        expect(parseProcessTable(`  801     1 ${identityText}   `, true)).toEqual([
            {
                command: 'Caxri Dev',
                identity: createHash('sha256').update(identityText).digest('hex'),
                parentPid: 1,
                pid: 801,
                startedAt: new Date(2026, 8, 24).getTime(),
            },
        ]);
    });

    it('never claims the installed application, another Electron app, or a sibling worktree', () => {
        for (const pid of [501, 502, 503, 504]) expect(stoppedIds(599)).not.toContain(pid);
    });

    it('claims processes executing out of this worktree, including an abandoned E2E Electron', () => {
        expect(stoppedIds(599)).toEqual([599, 600, 601, 602, 603, 604]);
    });

    it('reaches the launcher and the window process, neither of which any path can match', () => {
        /**
         * `dev` spawns `bun run dev` with the worktree as its working directory, and the window process reports the app
         * name; neither carries the worktree path, which is the gap that makes a name match tempting. Both are reached
         * as the recorded launcher and its subtree instead.
         */
        expect(isWorktreeOwnedCommand('Caxri Dev', WORKTREE)).toBe(false);
        expect(isWorktreeOwnedCommand('/Users/me/.bun/bin/bun run dev', WORKTREE)).toBe(false);
        expect(stoppedIds()).not.toContain(599);
        expect(stoppedIds(599)).toContain(599);
        expect(stoppedIds(599)).toContain(601);
    });

    it('reaches an orphaned dev main process only after verifying its worktree cwd', async () => {
        const orphaned = parseProcessTable(
            [
                '  801     1 Caxri Dev',
                `  802   801 ${WORKTREE}/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper --type=renderer`,
                `  803   801 /opt/homebrew/bin/node ${WORKTREE}/apps/server/dist/server/bundles/server-core.js`,
                `  700     1 /bin/zsh -lc cd ${WORKTREE} && bun run stop`,
                `  701   700 /Users/me/.bun/bin/bun run ${WORKTREE}/.agents/skills/switch-worktree/scripts/switch-worktree.ts stop`,
            ].join('\n'),
        ).map((entry) => (entry.pid === 801 ? { ...entry, identity: 'orphan-start' } : entry));

        const stop: StopOperations & { signals: number[] } = {
            cwd: (pid) => Promise.resolve(pid === 801 ? WORKTREE : undefined),
            identity: (pid) => Promise.resolve(pid === 801 ? 'orphan-start' : undefined),
            list: () => Promise.resolve(orphaned),
            signalProcess: (pid) => {
                stop.signals.push(pid);
            },
            signals: [],
            wait: () => Promise.resolve(),
        };

        await stopWorktreeProcesses({ selfPid: 701, worktreePath: WORKTREE }, stop);
        expect(stop.signals).toContain(801);
        expect(stop.signals).not.toContain(700);
        expect(stop.signals).not.toContain(701);

        stop.signals.length = 0;
        stop.cwd = () => Promise.resolve('/Applications/Caxri.app');
        await stopWorktreeProcesses({ selfPid: 701, worktreePath: WORKTREE }, stop);
        expect(stop.signals).not.toContain(801);

        stop.signals.length = 0;
        stop.cwd = () => Promise.resolve(WORKTREE);
        let identityReads = 0;
        stop.identity = () => Promise.resolve(`generation-${++identityReads}`);
        const reused = await stopWorktreeProcesses({ selfPid: 701, worktreePath: WORKTREE }, stop);
        expect(stop.signals).not.toContain(801);
        expect(reused.survivors.map(({ pid }) => pid)).toContain(801);
    });

    it('never signals the shell or the bun process running the stop command itself', () => {
        expect(stoppedIds(599)).not.toContain(700);
        expect(stoppedIds(599)).not.toContain(701);
    });

    it('claims a build artifact handed to an external runtime, but never a source path', () => {
        expect(
            isWorktreeOwnedCommand(
                `/opt/homebrew/bin/node ${WORKTREE}/node_modules/.bin/playwright test`,
                WORKTREE,
            ),
        ).toBe(true);
        /**
         * An editor or a search holding a file of this checkout open is not a process this checkout started.
         */
        expect(
            isWorktreeOwnedCommand(
                `/Applications/Visual Studio Code.app/Contents/MacOS/Electron ${WORKTREE}/apps/server/src/index.ts`,
                WORKTREE,
            ),
        ).toBe(false);
    });

    it('refuses a root path that would make every command look owned', () => {
        expect(isWorktreeOwnedCommand('/Applications/Caxri.app/Contents/MacOS/Caxri', '/')).toBe(
            false,
        );
        expect(isWorktreeOwnedCommand('/Applications/Caxri.app/Contents/MacOS/Caxri', '')).toBe(
            false,
        );
    });
});

describe('finding orphaned worktree processes', () => {
    const SIBLING = '/Users/me/code/caxri-worktrees/fix-other-9z8y7x6w';
    const PRIMARY = '/Users/me/code/caxri';
    const NESTED = `${PRIMARY}/.claude/worktrees/nested`;

    function orphanIds(table: string, paths = [WORKTREE, SIBLING]): Record<string, number[]> {
        return Object.fromEntries(
            findOrphanedProcesses(parseProcessTable(table), paths)
                .entries()
                .map(([path, found]) => [path, found.map((entry) => entry.pid)]),
        );
    }

    it('reports an unsupervised checkout but never one with a live launcher subtree', () => {
        /**
         * 599 is a backgrounded `bun run dev` launcher that launchd already adopted: its subtree is supervised, so this
         * worktree's detached 603/604 are presumed adopted. The sibling checkout's 504 has nothing supervising it.
         */
        expect(orphanIds(TABLE)).toEqual({ [SIBLING]: [504] });
    });

    it('reports a detached Server once no supervised run remains in its checkout', () => {
        const table = [
            `  603     1 ${WORKTREE}/apps/server/dist/server/runtime/bin/node ${WORKTREE}/apps/server/dist/server/bundles/server-core.js`,
            `  605   603 ${WORKTREE}/apps/server/dist/server/runtime/bin/node ${WORKTREE}/apps/server/dist/server/bundles/extension-host.js`,
        ].join('\n');

        expect(orphanIds(table)).toEqual({ [WORKTREE]: [603, 605] });
    });

    it('ignores a run whose parent chain still ends at a shell, Playwright, or agent', () => {
        const table = [
            '  900     1 /Applications/Terminal.app/Contents/MacOS/Terminal',
            '  901   900 /bin/zsh -l',
            `  902   901 /opt/homebrew/bin/node ${WORKTREE}/node_modules/@playwright/test/cli.js test`,
            `  903   902 ${WORKTREE}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
        ].join('\n');

        expect(orphanIds(table)).toEqual({});
    });

    it('includes an orphaned dev window nominated by its worktree-owned child', () => {
        const table = [
            '  801     1 Caxri Dev',
            `  802   801 ${WORKTREE}/apps/server/dist/server/runtime/bin/node ${WORKTREE}/apps/server/dist/server/bundles/server-core.js`,
            `  803   802 ${WORKTREE}/apps/server/dist/server/runtime/bin/node ${WORKTREE}/apps/server/dist/server/bundles/extension-host.js`,
        ].join('\n');

        expect(orphanIds(table)).toEqual({ [WORKTREE]: [801, 802, 803] });
    });

    it('attributes a nested checkout only to its own root', () => {
        const table = `  810     1 ${NESTED}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;

        expect(orphanIds(table, [PRIMARY, NESTED])).toEqual({ [NESTED]: [810] });
    });
});

/**
 * A mocked `StopOperations` whose `list` reports `alive(round)` on each call (round 1 is the first snapshot, round 2
 * the first survivor check, and so on) and whose `signalProcess` just records calls by default. Shared by the stop and
 * closed-reason describes below so both exercise the identity plumbing identically.
 */
function operations(alive: (round: number) => ProcessEntry[]): StopOperations & {
    signals: Array<[number, NodeJS.Signals]>;
} {
    const signals: Array<[number, NodeJS.Signals]> = [];
    let round = 0;
    return {
        cwd: () => Promise.resolve(undefined),
        identity: (pid) => Promise.resolve(`start-${pid}`),
        list: () => {
            round += 1;
            return Promise.resolve(
                alive(round).map((entry) => ({
                    ...entry,
                    identity: entry.identity ?? `start-${entry.pid}`,
                })),
            );
        },
        signalProcess: (pid, signal) => {
            signals.push([pid, signal]);
        },
        signals,
        wait: () => Promise.resolve(),
    };
}

describe('stopping owned processes', () => {
    it('escalates to SIGKILL only for the processes that survived SIGTERM', async () => {
        const targets = entries()
            .filter((entry) => [600, 603].includes(entry.pid))
            .map((entry) => ({ ...entry, identity: `start-${entry.pid}` }));
        const stubborn = targets.filter((entry) => entry.pid === 603);
        const stop = operations(() => stubborn);

        const result = await stopProcesses(targets, stop);

        expect(stop.signals.filter(([, signal]) => signal === 'SIGTERM')).toEqual([
            [600, 'SIGTERM'],
            [603, 'SIGTERM'],
        ]);
        expect(stop.signals.filter(([, signal]) => signal === 'SIGKILL')).toEqual([
            [603, 'SIGKILL'],
        ]);
        expect(result.survivors.map(({ pid }) => pid)).toEqual([603]);
        expect(result.stopped.map(({ pid }) => pid)).toEqual([600]);
    });

    it('sends no signal at all when this checkout started nothing', async () => {
        const stop = operations(() => []);
        const list = vi.spyOn(stop, 'list');

        await expect(stopProcesses([], stop)).resolves.toEqual({ stopped: [], survivors: [] });

        expect(stop.signals).toEqual([]);
        expect(list).not.toHaveBeenCalled();
    });

    it('does not signal a PID reused after the ownership snapshot', async () => {
        const original: ProcessEntry = {
            command: 'Caxri Dev',
            identity: 'original-start',
            parentPid: 1,
            pid: 900,
        };
        const replacement = { ...original, identity: 'replacement-start' };
        const stop = operations(() => [replacement]);
        stop.identity = () => Promise.resolve(replacement.identity);

        const result = await stopProcesses([original], stop);

        expect(stop.signals).toEqual([]);
        expect(result).toEqual({ stopped: [original], survivors: [] });
    });

    it('does not escalate when the original PID is reused after SIGTERM', async () => {
        const original: ProcessEntry = {
            command: 'Caxri Dev',
            identity: 'original-start',
            parentPid: 1,
            pid: 900,
        };
        const replacement = { ...original, identity: 'replacement-start' };
        const stop = operations(() => [replacement]);
        let reads = 0;
        stop.identity = () =>
            Promise.resolve(++reads === 1 ? original.identity : replacement.identity);

        const result = await stopProcesses([original], stop);

        expect(stop.signals).toEqual([[900, 'SIGTERM']]);
        expect(result).toEqual({ stopped: [original], survivors: [] });
    });

    it('also attempts a newly discovered owned process instead of only reporting it as a survivor', async () => {
        const original = {
            pid: 900,
            parentPid: 1,
            command: `${WORKTREE}/apps/server/dist/server-core.js`,
        };
        const replacement = { ...original, pid: 901 };
        const stop = operations((round) =>
            round === 1 ? [original] : round === 2 ? [] : [replacement],
        );

        const result = await stopWorktreeProcesses({ selfPid: 701, worktreePath: WORKTREE }, stop);

        // 900 exits cleanly after SIGTERM. 901 only becomes visible afterward, standing in for a descendant that
        // had not finished forking, or one reparented to independent path-ownership once its supervisor exited,
        // and must still receive its own SIGTERM/SIGKILL round, not merely be reported unexplained.
        expect(stop.signals).toEqual([
            [900, 'SIGTERM'],
            [901, 'SIGTERM'],
            [901, 'SIGKILL'],
        ]);
        expect(result.stopped.map(({ pid }) => pid)).toEqual([900]);
        expect(result.survivors.map(({ pid }) => pid)).toEqual([901]);
    });

    /**
     * The bug behind #1179: a process invisible to the very first ownership snapshot (a descendant still mid-fork, or
     * one that only becomes independently path-owned once its parent exits) used to be detected by the trailing re-scan
     * and reported as a survivor without `stop` ever having sent it a signal. It must instead get its own stop round
     * once discovered.
     */
    it('stops a process that only becomes visible after an earlier one exits, instead of leaving it unexplained', async () => {
        const early: ProcessEntry = {
            command: `${WORKTREE}/apps/server/dist/server-core.js`,
            identity: 'start-910',
            parentPid: 1,
            pid: 910,
        };
        const late: ProcessEntry = {
            command: `${WORKTREE}/apps/server/dist/extension-host.js`,
            identity: 'start-911',
            parentPid: 910,
            pid: 911,
        };
        let isEarlyAlive = true;
        let isLateExists = false;
        let isLateAlive = true;
        const signals: Array<[number, NodeJS.Signals]> = [];
        const stop: StopOperations & { signals: typeof signals } = {
            cwd: () => Promise.resolve(undefined),
            identity: (pid) =>
                Promise.resolve(pid === 910 ? 'start-910' : pid === 911 ? 'start-911' : undefined),
            list: () => {
                const alive: ProcessEntry[] = [];
                if (isEarlyAlive) alive.push(early);
                else isLateExists = true; // the descendant only becomes visible once its parent is confirmed gone
                if (isLateExists && isLateAlive) alive.push(late);
                return Promise.resolve(alive);
            },
            signalProcess: (pid, signal) => {
                signals.push([pid, signal]);
                if (pid === 910) isEarlyAlive = false;
                else if (pid === 911) isLateAlive = false;
                return { ok: true };
            },
            signals,
            wait: () => Promise.resolve(),
        };

        const result = await stopWorktreeProcesses({ selfPid: 701, worktreePath: WORKTREE }, stop);

        expect(signals.map(([pid]) => pid)).toEqual([910, 911]);
        expect(result.survivors).toEqual([]);
        expect(result.stopped.map(({ pid }) => pid).toSorted((a, b) => a - b)).toEqual([910, 911]);
    });
});

describe('closed reasons for signal failures', () => {
    /**
     * @see https://github.com/tjx666/caxri/issues/1179
     */
    it('records why a signal never landed instead of leaving every survivor equally unexplained', async () => {
        const targets = entries()
            .filter((entry) => [600, 603].includes(entry.pid))
            .map((entry) => ({ ...entry, identity: `start-${entry.pid}` }));
        const stop = operations(() => targets);
        stop.signalProcess = (pid, signal) => {
            stop.signals.push([pid, signal]);
            // 600 is refused on every attempt; 603 is signaled fine but just never exits (a slow graceful shutdown).
            return pid === 600 ? { ok: false, reason: 'permission-denied' } : { ok: true };
        };

        const result = await stopProcesses(targets, stop);

        const reasons = new Map(
            result.survivors.map(({ closedReason, pid }) => [pid, closedReason]),
        );
        expect(reasons.get(600)).toBe('permission-denied');
        expect(reasons.get(603)).toBeUndefined();
    });

    it('never calls process.kill for a target whose snapshot never captured a start-time identity', async () => {
        const target: ProcessEntry = { command: 'Caxri Dev', parentPid: 1, pid: 950 };
        const stop = operations(() => [target]);

        await stopProcesses([target], stop);

        expect(stop.signals).toEqual([]);
    });

    it('reports identity-changed, not a plain unexplained survivor, when the live identity shifts right before escalation', async () => {
        const target: ProcessEntry = {
            command: 'Caxri Dev',
            identity: 'start-970',
            parentPid: 1,
            pid: 970,
        };
        const stop = operations(() => [target]);
        let identityReads = 0;
        stop.identity = () => {
            identityReads += 1;
            // The SIGTERM round's pre-signal recheck matches; the SIGKILL round's does not (a PID reused mid-stop).
            return Promise.resolve(identityReads === 1 ? 'start-970' : 'reused-970');
        };

        const result = await stopProcesses([target], stop);

        expect(stop.signals).toEqual([[970, 'SIGTERM']]);
        expect(result.survivors.find(({ pid }) => pid === 970)?.closedReason).toBe(
            'identity-changed',
        );
    });

    it("classifies process.kill's real errno instead of swallowing it", () => {
        // A signal to PID 1 (launchd) as a non-root user is refused; the classification must not be lost.
        expect(defaultStopOperations.signalProcess(1, 'SIGTERM')).toEqual({
            ok: false,
            reason: 'permission-denied',
        });
        // A PID nothing on the system is using is the benign case: the target is simply already gone.
        expect(defaultStopOperations.signalProcess(999_999, 'SIGTERM')).toEqual({
            ok: false,
            reason: 'already-exited',
        });
    });

    it('reports success for a real owned process it actually signals', async () => {
        const child = spawn('sh', ['-c', 'while true; do sleep 1; done'], { stdio: 'ignore' });
        try {
            await sleep(200);
            expect(defaultStopOperations.signalProcess(child.pid!, 'SIGTERM')).toEqual({
                ok: true,
            });
        } finally {
            try {
                process.kill(child.pid!, 'SIGKILL');
            } catch {
                /*
                already gone
                */
            }
        }
    });
});
