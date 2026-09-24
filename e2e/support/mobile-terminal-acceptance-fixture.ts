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
    rows: number | null;
    selected: number;
    submissions: number;
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
 * The fake Agent prints only synthetic ANSI colors and a two-choice menu. Its private state file records the selected
 * option and submission count, never Terminal output or input bytes.
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
const statePath = ${JSON.stringify(statePath)};
const save = () => {
  fs.writeFileSync(statePath + '.next', JSON.stringify({
    cols: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
    selected,
    submissions,
  }));
  fs.renameSync(statePath + '.next', statePath);
};
save();
process.on('SIGWINCH', save);
process.stdout.write('\x1b[32mSynthetic Agent ready\x1b[0m\r\nChoose an option:\r\n  1. First\r\n  2. Second\r\n');
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length > 0) {
    const first = pending[0];
    if (first === 27) {
      if (pending.length < 3) break;
      if (pending[1] === 91 && pending[2] === 66) {
        selected = 2;
        process.stdout.write('\x1b[36mSecond selected\x1b[0m\r\n');
      } else if (pending[1] === 91 && pending[2] === 65) {
        selected = 1;
        process.stdout.write('\x1b[36mFirst selected\x1b[0m\r\n');
      }
      pending = pending.subarray(3);
      save();
      continue;
    }
    pending = pending.subarray(1);
    if (first !== 13 && first !== 10) continue;
    submissions += 1;
    process.stdout.write('\x1b[35mSelection submitted\x1b[0m\r\n');
    save();
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
            async () => JSON.parse(await readFile(statePath, 'utf8')) as MenuState,
            ({ selected, submissions }) => selected === 1 && submissions === 0,
        );

        return {
            menuState: async () => JSON.parse(await readFile(statePath, 'utf8')) as MenuState,
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
