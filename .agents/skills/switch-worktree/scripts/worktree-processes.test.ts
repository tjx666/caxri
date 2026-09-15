import { describe, expect, it, vi } from 'vitest';

import type { ProcessEntry, StopOperations } from './worktree-processes';
import {
    isWorktreeOwnedCommand,
    parseProcessTable,
    stopProcesses,
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
    it('keeps the two leading columns apart from command lines that contain spaces', () => {
        const helper = parseProcessTable(TABLE).find((entry) => entry.pid === 502);

        expect(helper).toEqual({
            command:
                '/Applications/Caxri.app/Contents/Frameworks/Caxri Helper (Renderer).app/Contents/MacOS/Caxri Helper (Renderer) --type=renderer',
            parentPid: 501,
            pid: 502,
        });
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
         * name — neither carries the worktree path, which is the gap that makes a name match tempting. Both are reached
         * as the recorded launcher and its subtree instead.
         */
        expect(isWorktreeOwnedCommand('Caxri Dev', WORKTREE)).toBe(false);
        expect(isWorktreeOwnedCommand('/Users/me/.bun/bin/bun run dev', WORKTREE)).toBe(false);
        expect(stoppedIds()).not.toContain(599);
        expect(stoppedIds(599)).toContain(599);
        expect(stoppedIds(599)).toContain(601);
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

describe('stopping owned processes', () => {
    function operations(alive: (round: number) => ProcessEntry[]): StopOperations & {
        signals: Array<[number, NodeJS.Signals]>;
    } {
        const signals: Array<[number, NodeJS.Signals]> = [];
        let round = 0;
        return {
            list: () => {
                round += 1;
                return Promise.resolve(alive(round));
            },
            signalProcess: (pid, signal) => signals.push([pid, signal]),
            signals,
            wait: () => Promise.resolve(),
        };
    }

    it('escalates to SIGKILL only for the processes that survived SIGTERM', async () => {
        const targets = entries().filter((entry) => [600, 603].includes(entry.pid));
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
});
