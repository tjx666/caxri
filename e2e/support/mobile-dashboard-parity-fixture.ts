import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';
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

type DashboardRole = 'completed' | 'running' | 'waiting';

export interface MobileDashboardParityFixture {
    pair(): Promise<void>;
    projectId: string;
    running: RunningCaxri;
    sessionIds: Record<DashboardRole, string>;
    stop(): Promise<void>;
    triggerRunningToWaiting(): Promise<{ attentionGeneration: number; triggeredAt: number }>;
}

const dashboardState = (state: BootstrapState, sessionIds: Record<DashboardRole, string>) =>
    Object.fromEntries(
        (Object.entries(sessionIds) as Array<[DashboardRole, string]>).map(([role, id]) => [
            role,
            state.sessions.find((session) => session.id === id),
        ]),
    ) as Record<DashboardRole, BootstrapState['sessions'][number] | undefined>;

async function createDashboardAgent(userData: string, triggerPath: string) {
    const launchCountPath = join(userData, 'dashboard-agent-launch-count');
    return createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
// 用隔离的合成 Agent 更新三个 Session；只写临时启动计数并监听临时触发文件。
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
if (process.argv.includes('app-server')) {
  process.exit(0);
}
const countPath = ${JSON.stringify(launchCountPath)};
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1;
fs.writeFileSync(countPath, String(count));
const role = ['waiting', 'running', 'completed'][count - 1];
if (!role) throw new Error('Unexpected synthetic Agent launch');
const fixtureSessionId = 'mobile-dashboard-' + role + '-' + process.pid;
function invokeHook(event, turnId) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({ session_id: fixtureSessionId, turn_id: turnId }),
  });
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Synthetic Agent output: ready for Acceptance review.\r\n');
setTimeout(() => {
  invokeHook('UserPromptSubmit', 'initial-turn');
  if (role === 'waiting') invokeHook('PermissionRequest', 'initial-turn');
  if (role === 'completed') invokeHook('Stop', 'initial-turn');
}, 500);
if (role === 'running') {
  const triggerPath = ${JSON.stringify(triggerPath)};
  let triggered = false;
  fs.watchFile(triggerPath, { interval: 50 }, () => {
    if (triggered || !fs.existsSync(triggerPath)) return;
    triggered = true;
    invokeHook('PermissionRequest', 'initial-turn');
    fs.unwatchFile(triggerPath);
  });
}
`,
            },
        },
    });
}

/**
 * Builds three real Server Sessions through one isolated fake Agent executable. The trigger changes only the running
 * Session, so the phone can stay on its home list throughout the timing capture.
 */
export async function createMobileDashboardParityFixture(
    serial: string,
): Promise<MobileDashboardParityFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-dashboard-parity-'));
    const userData = join(directory, 'user-data');
    const projectRoot = join(directory, 'synthetic-project');
    const triggerPath = join(directory, 'running-to-waiting');
    await mkdir(projectRoot, { recursive: true });
    const agentMode = await createDashboardAgent(userData, triggerPath);
    let running: RunningCaxri;
    try {
        running = await launchCaxri({
            agentMode,
            userDataDir: userData,
            testRootPath: projectRoot,
            env: {
                CAXRI_E2E_AGENT_HOOKS: '1',
                CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host',
            },
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
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        const settings = structuredClone(currentSettings.value);
        settings['agents.providers'].codex.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        const waiting = await createProjectSession(running.page, 'codex');
        await waitForMobile(
            () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
            (state) =>
                state.sessions.some(
                    ({ id, agentActivityState }) =>
                        id === waiting && agentActivityState === 'waiting',
                ),
        );
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const projectId = bootstrap.sessions.find(({ id }) => id === waiting)?.projectId;
        if (!projectId) throw new Error('Synthetic Project was not created');
        const runningSession = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            { projectId, defaultAgent: 'codex' },
        );
        await pageRequest(running.page, 'session.select', { sessionId: runningSession.session.id });
        await waitForMobile(
            () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
            (state) =>
                state.sessions.some(
                    ({ id, agentActivityState }) =>
                        id === runningSession.session.id && agentActivityState === 'running',
                ),
        );
        const completedSession = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            { projectId, defaultAgent: 'codex' },
        );
        await pageRequest(running.page, 'session.select', {
            sessionId: completedSession.session.id,
        });
        const sessionIds = {
            waiting,
            running: runningSession.session.id,
            completed: completedSession.session.id,
        };
        /**
         * The fake Codex executable has no app-server rename endpoint. Write only this disposable fixture database so
         * every subsequent mobile snapshot has a visually blank Session title before any framebuffer is captured.
         */
        const database = new Database(join(userData, 'caxri.db'));
        try {
            const hideTitle = database.prepare(
                "UPDATE sessions SET title = ?, title_mode = 'manual' WHERE id = ?",
            );
            database.transaction(() => {
                for (const sessionId of Object.values(sessionIds)) {
                    if (hideTitle.run('\u{200B}', sessionId).changes !== 1)
                        throw new Error('Synthetic Session title could not be hidden');
                }
            })();
        } finally {
            database.close();
        }
        const ready = await waitForMobile(
            () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
            (state) => {
                const sessions = dashboardState(state, sessionIds);
                return (
                    sessions.waiting?.agentActivityState === 'waiting' &&
                    sessions.running?.agentActivityState === 'running' &&
                    sessions.completed?.agentActivityState === 'completed'
                );
            },
        );
        const completed = dashboardState(ready, sessionIds).completed;
        if (!completed) throw new Error('Completed synthetic Session is missing');
        if (completed.hasUnread)
            await pageRequest(running.page, 'session.markRead', {
                sessionId: completed.id,
                attentionGeneration: completed.attentionGeneration,
            });
        return {
            projectId,
            running,
            sessionIds,
            pair: async () => {
                await pageRequest(running.page, 'mobile.access.enable');
                const dashboard = await pageRequest<{
                    hostDisplayName: string;
                    projects: Array<{ title: string }>;
                    sessions: Array<{ title: string; id: string }>;
                }>(running.page, 'mobile.dashboard');
                if (
                    dashboard.hostDisplayName !== 'Caxri Test Host' ||
                    dashboard.projects.length !== 1 ||
                    dashboard.projects[0]?.title !== 'synthetic-project' ||
                    Object.values(sessionIds).some(
                        (id) =>
                            dashboard.sessions.find((session) => session.id === id)?.title !==
                            '\u{200B}',
                    )
                )
                    throw new Error('Mobile dashboard privacy preflight failed');
                const pairing = await pageRequest<{ pairingLink: string }>(
                    running.page,
                    'mobile.pairing.create',
                    { projectIds: [projectId] },
                );
                await openMobilePairingLink(serial, pairing.pairingLink);
                await waitForMobile(
                    () => mobileSemantics(serial),
                    (nodes) =>
                        Object.values(sessionIds).every((id) =>
                            nodes.some(({ checkId }) => checkId === `session-row-${id}`),
                        ),
                );
            },
            triggerRunningToWaiting: async () => {
                const triggeredAt = Date.now();
                await writeFile(triggerPath, 'waiting', { flag: 'wx' });
                const changed = await waitForMobile(
                    () => pageRequest<BootstrapState>(running.page, 'app.bootstrap'),
                    (state) =>
                        dashboardState(state, sessionIds).running?.agentActivityState === 'waiting',
                );
                const transitioned = dashboardState(changed, sessionIds).running;
                if (!transitioned) throw new Error('Running synthetic Session is missing');
                return { attentionGeneration: transitioned.attentionGeneration, triggeredAt };
            },
            stop,
        };
    } catch (error) {
        await stop();
        throw error;
    }
}
