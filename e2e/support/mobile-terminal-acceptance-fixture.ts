import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';
import Database from 'better-sqlite3';

import { createFakeAgentMode } from './agent-fixture';
import type { RunningCaxri } from './helpers';
import { createProjectSession, launchCaxri, pageRequest } from './helpers';
import {
    mobileSemantics,
    openMobilePairingLink,
    runMobileDeviceCommand,
    waitForMobile,
} from './mobile-android';

interface MenuState {
    cols: number | null;
    firstGridMarker: { columns: number; generation: string; rows: number };
    generation: string;
    lines: string[];
    rows: number | null;
    selected: number;
    submissions: number;
}

async function readMenuState(statePath: string): Promise<MenuState> {
    return JSON.parse(await readFile(statePath, 'utf8')) as MenuState;
}

async function readMenuStateIfReady(statePath: string): Promise<MenuState | null> {
    try {
        return await readMenuState(statePath);
    } catch (error) {
        if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return null;
        throw error;
    }
}

export interface MobileTerminalAcceptanceFixture {
    menuState(): Promise<MenuState>;
    pair(): Promise<void>;
    running: RunningCaxri;
    sessionId: string;
    stop(): Promise<void>;
    terminalId: string;
}

/**
 * The fake Agent fills every visible Terminal cell with synthetic content. Its temporary state contains only the
 * synthetic grid, selected option, and submission count; it never records user Terminal input.
 */
async function createMenuAgent(userData: string, statePath: string) {
    return createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
// 为隔离验收输出合成彩色菜单；只修改临时选择状态文件。
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
if (process.argv.includes('app-server')) process.exit(0);
process.stdin.setRawMode?.(true);
process.stdin.resume();
let selected = 1;
let submissions = 0;
let pending = Buffer.alloc(0);
let generationNumber = 0;
const statePath = ${JSON.stringify(statePath)};
const render = () => {
  const cols = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  if (cols < 18 || rows < 4) return;
  const generation = 'G' + (++generationNumber);
  const labels = Array.from({ length: rows }, (_, index) => 'Synthetic row ' + String(index + 1).padStart(2, '0'));
  labels[0] = generation + ' Agent ready';
  labels[1] = selected === 1 ? '> 1. First' : '  1. First';
  labels[2] = selected === 2 ? '> 2. Second' : '  2. Second';
  labels[rows - 1] = submissions > 0 ? 'Selection submitted' : 'Choose an option';
  const lines = labels.map((label) => '│' + label.slice(0, cols - 2).padEnd(cols - 2, ' ') + '│');
  process.stdout.write('\x1b[?7l\x1b[2J');
  for (const [index, line] of lines.entries()) {
    const color = index === 0 ? 32 : index === selected ? 36 : index === rows - 1 && submissions > 0 ? 35 : 37;
    process.stdout.write('\x1b[' + (index + 1) + ';1H\x1b[' + color + 'm' + line + '\x1b[0m');
  }
  process.stdout.write('\x1b[?7h');
  fs.writeFileSync(statePath + '.next', JSON.stringify({
    cols,
    firstGridMarker: { columns: cols, generation, rows },
    generation,
    lines,
    rows,
    selected,
    submissions,
  }));
  fs.renameSync(statePath + '.next', statePath);
};
process.stdout.on('resize', render);
process.on('SIGWINCH', render);
setTimeout(render, 250);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length > 0) {
    const first = pending[0];
    if (first === 27) {
      if (pending.length < 3) break;
      if (pending[1] === 91 && pending[2] === 66) {
        selected = 2;
      } else if (pending[1] === 91 && pending[2] === 65) {
        selected = 1;
      }
      pending = pending.subarray(3);
      render();
      continue;
    }
    pending = pending.subarray(1);
    if (first !== 13 && first !== 10) continue;
    submissions += 1;
    render();
  }
});
`,
            },
        },
    });
}

export async function createMobileTerminalAcceptanceFixture(
    serial: string,
): Promise<MobileTerminalAcceptanceFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-terminal-acceptance-'));
    const userData = join(directory, 'user-data');
    const projectRoot = join(directory, 'synthetic-project');
    const statePath = join(directory, 'menu-state.json');
    await mkdir(projectRoot, { recursive: true });
    const agentMode = await createMenuAgent(userData, statePath);
    let running: RunningCaxri;
    try {
        running = await launchCaxri({
            desktopLeaseWaitMs: process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID ? 120_000 : 0,
            agentMode,
            userDataDir: userData,
            testRootPath: projectRoot,
            env: { CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host' },
        });
    } catch (error) {
        await rm(directory, { force: true, recursive: true });
        throw error;
    }

    let isStopped = false;
    const stop = async (): Promise<void> => {
        if (isStopped) return;
        isStopped = true;
        let failure: unknown;
        try {
            await pageRequest(running.page, 'mobile.access.disable');
        } catch {
            // Closing the isolated profile also ends mobile access.
        }
        try {
            await running.app.close();
        } catch (error) {
            failure = error;
        }
        try {
            await waitForMobile(
                () => runMobileDeviceCommand('/bin/ps', ['-axo', 'pid=,args='], 'capture'),
                (processes) => processes.split('\n').every((line) => !line.includes(userData)),
            );
        } catch (error) {
            failure ??= error;
        }
        try {
            await rm(directory, { force: true, recursive: true });
        } catch (error) {
            failure ??= error;
        }
        if (failure) throw failure instanceof Error ? failure : new Error('Fixture cleanup failed');
    };

    try {
        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ checkboxChecked: false, response: 0 });
        });
        const sessionId = await createProjectSession(running.page, 'codex');
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const session = bootstrap.sessions.find(({ id }) => id === sessionId);
        const terminal = bootstrap.terminals.find(({ sessionId: id }) => id === sessionId);
        if (!session || !terminal) throw new Error('Synthetic Terminal is unavailable');

        const database = new Database(join(userData, 'caxri.db'));
        try {
            const result = database
                .prepare(
                    "UPDATE sessions SET display_title = ?, title_mode = 'manual' WHERE id = ?",
                )
                .run('\u{200B}', sessionId);
            if (result.changes !== 1)
                throw new Error('Synthetic Session title could not be hidden');
        } finally {
            database.close();
        }

        await waitForMobile(
            () => readMenuStateIfReady(statePath),
            (state) => state?.selected === 1 && state.submissions === 0,
        );

        return {
            menuState: () => readMenuState(statePath),
            pair: async () => {
                await pageRequest(running.page, 'mobile.access.enable');
                const dashboard = await pageRequest<{
                    hostDisplayName: string;
                    projects: Array<{ displayTitle: string }>;
                    sessions: Array<{ displayTitle: string; id: string }>;
                }>(running.page, 'mobile.dashboard');
                if (
                    dashboard.hostDisplayName !== 'Caxri Test Host' ||
                    dashboard.projects.length !== 1 ||
                    dashboard.projects[0]?.displayTitle !== 'synthetic-project' ||
                    dashboard.sessions.find(({ id }) => id === sessionId)?.displayTitle !==
                        '\u{200B}'
                ) {
                    throw new Error('Mobile Terminal fixture privacy preflight failed');
                }
                const pairing = await pageRequest<{ pairingLink: string }>(
                    running.page,
                    'mobile.pairing.create',
                    { projectIds: [session.projectId] },
                );
                await openMobilePairingLink(serial, pairing.pairingLink);
                await waitForMobile(
                    () => mobileSemantics(serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === `session-row-${sessionId}`),
                );
            },
            running,
            sessionId,
            stop,
            terminalId: terminal.id,
        };
    } catch (error) {
        await stop();
        throw error;
    }
}
