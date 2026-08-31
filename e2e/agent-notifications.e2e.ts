import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './support/helpers.ts';

const SESSION_TITLE = 'Background notification source';

async function waitForReceipt(path: string): Promise<void> {
    await expect
        .poll(async () => {
            const receipt = await readFileIfPresent(path);
            if (receipt === 'failed') throw new Error('Fake Claude hook invocation failed');
            return receipt;
        })
        .toBe('done');
}

async function readFileIfPresent(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return '';
        throw error;
    }
}

async function writeClaudeMetadata(
    configDirectory: string,
    root: string,
    startedAt: number,
    status: 'busy' | 'idle',
): Promise<void> {
    const sessions = join(configDirectory, 'sessions');
    const target = join(sessions, 'session.json');
    const temporary = join(sessions, 'session.next.json');
    await writeFile(
        temporary,
        JSON.stringify({
            cwd: root,
            name: SESSION_TITLE,
            sessionId: 'claude-notification-session',
            startedAt: new Date(startedAt).toISOString(),
            status,
            updatedAt: new Date().toISOString(),
        }),
        'utf8',
    );
    await rename(temporary, target);
    await writeFile(join(configDirectory, 'trigger'), String(Date.now()), 'utf8');
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('a background Agent notification survives Keep Running and restores its exact Session', async ({}) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-notification-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const config = join(userData, 'e2e-agents', 'claude');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(join(config, 'sessions'), { recursive: true }),
    ]);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
process.stdout.write('Fake Claude ready with SECRET_PROMPT_MARKER\n');
setInterval(() => {
  const trigger = path.join(process.env.CLAUDE_CONFIG_DIR, 'trigger');
  if (!fs.existsSync(trigger)) return;
  fs.rmSync(trigger);
  process.stdout.write('metadata changed with SECRET_RESPONSE_MARKER\n');
}, 50);
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'visible',
    });

    try {
        const sourceSessionId = await createProjectSession(running.page, 'claude');
        const startedAt = Date.now();
        await writeClaudeMetadata(config, root, startedAt, 'busy');
        await expect
            .poll(async () => {
                const state = await pageRequest<{
                    sessions: Array<{ id: string; lastActivityState: string }>;
                }>(running.page, 'app.bootstrap');
                return state.sessions.find((session) => session.id === sourceSessionId)
                    ?.lastActivityState;
            })
            .toBe('running');
        await createAdditionalShellSession(running.page);
        const foregroundSessionId = (
            await pageRequest<{ selectedSessionId: string }>(running.page, 'app.bootstrap')
        ).selectedSessionId;
        expect(foregroundSessionId).not.toBe(sourceSessionId);

        /**
         * Unsigned Electron development builds cannot leave inspectable macOS Notification Center history. Patch only
         * `show()` so the real Electron Notification object and click EventEmitter boundary remain under test; final
         * Acceptance separately captures the actual system banner.
         */
        await running.app.evaluate(({ Notification }) => {
            type RecordedNotification = InstanceType<typeof Notification>;
            const state = globalThis as typeof globalThis & {
                __caxriAgentNotifications?: RecordedNotification[];
            };
            state.__caxriAgentNotifications = [];
            Notification.isSupported = () => true;
            Notification.prototype.show = function show(): void {
                // Electron invokes this prototype method with the live native Notification instance.
                // eslint-disable-next-line unicorn/no-this-outside-of-class -- prototype test seam
                state.__caxriAgentNotifications?.push(this);
            };
        });

        await running.app.evaluate(({ dialog }) => {
            dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
        });
        const closed = running.page.waitForEvent('close');
        await running.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.close(),
        );
        await closed;
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
            )
            .toBe(0);

        await writeClaudeMetadata(config, root, startedAt, 'idle');
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    interface RecordedNotification {
                        body: string;
                        groupId: string;
                        id: string;
                        title: string;
                    }
                    const state = globalThis as typeof globalThis & {
                        __caxriAgentNotifications?: RecordedNotification[];
                    };
                    return (state.__caxriAgentNotifications ?? []).map((notification) => ({
                        body: notification.body,
                        groupId: notification.groupId,
                        id: notification.id,
                        title: notification.title,
                    }));
                }),
            )
            .toEqual([
                {
                    body: 'Claude Code is waiting for your input.',
                    groupId: 'caxri-agent-sessions',
                    id: `caxri-agent-session-${sourceSessionId}`,
                    title: SESSION_TITLE,
                },
            ]);
        expect(
            JSON.stringify(
                await running.app.evaluate(() => {
                    interface RecordedNotification {
                        body: string;
                        title: string;
                    }
                    const state = globalThis as typeof globalThis & {
                        __caxriAgentNotifications?: RecordedNotification[];
                    };
                    return (state.__caxriAgentNotifications ?? []).map((notification) => ({
                        body: notification.body,
                        title: notification.title,
                    }));
                }),
            ),
        ).not.toContain('SECRET_');

        await running.app.evaluate(({ BrowserWindow }) => {
            const state = globalThis as typeof globalThis & {
                __caxriAgentNotificationFocusCalls?: number;
            };
            state.__caxriAgentNotificationFocusCalls = 0;
            BrowserWindow.prototype.focus = (): void => {
                state.__caxriAgentNotificationFocusCalls =
                    (state.__caxriAgentNotificationFocusCalls ?? 0) + 1;
            };
        });
        const reopenedPromise = running.app.waitForEvent('window');
        await running.app.evaluate(() => {
            interface RecordedNotification {
                emit(event: string, value: unknown): boolean;
            }
            const state = globalThis as typeof globalThis & {
                __caxriAgentNotifications?: RecordedNotification[];
            };
            state.__caxriAgentNotifications?.at(-1)?.emit('click', {});
        });
        const reopened = await reopenedPromise;
        await waitForRuntimeReady(reopened);
        await expect
            .poll(async () => {
                const state = await pageRequest<{ selectedSessionId?: string }>(
                    reopened,
                    'app.bootstrap',
                );
                return state.selectedSessionId;
            })
            .toBe(sourceSessionId);
        await expect(reopened.locator(`[data-session-id="${sourceSessionId}"]`)).toHaveClass(
            /(^|\s)active(\s|$)/,
        );
        /**
         * A self-hosted macOS runner may deny foreground focus to an unsigned test process even after Electron calls
         * `focus()`. Assert that Caxri invoked the native focus boundary, while Acceptance verifies the actual
         * desktop.
         */
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    const state = globalThis as typeof globalThis & {
                        __caxriAgentNotificationFocusCalls?: number;
                    };
                    return state.__caxriAgentNotificationFocusCalls ?? 0;
                }),
            )
            .toBeGreaterThan(0);
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) => {
                    const window = BrowserWindow.getAllWindows()[0];
                    return {
                        minimized: window.isMinimized(),
                        visible: window.isVisible(),
                    };
                }),
            )
            .toEqual({ minimized: false, visible: true });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('a Claude subagent completion keeps the Session running without unread attention or a notification', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-subagent-notification-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const config = join(userData, 'e2e-agents', 'claude');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
const config = process.env.CLAUDE_CONFIG_DIR;
function invokeHook(event, payload) {
  const settings = JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'));
  const group = settings.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify(payload),
  });
}
const actions = [
  ['turn-started', 'UserPromptSubmit', {}],
  ['subagent-finished', 'Stop', { agent_id: 'subagent-1' }],
  ['parent-finished', 'Stop', {}],
];
setInterval(() => {
  for (const [name, event, payload] of actions) {
    const trigger = path.join(config, name);
    if (!fs.existsSync(trigger)) continue;
    fs.rmSync(trigger);
    try {
      invokeHook(event, payload);
      fs.writeFileSync(trigger + '.receipt', 'done');
    } catch {
      fs.writeFileSync(trigger + '.receipt', 'failed');
    }
  }
}, 25);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Fake Claude subagent lifecycle ready\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        testRootPath: root,
        userDataDir: userData,
    });

    try {
        const current = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        const settings = structuredClone(current.value);
        settings['agents.providers'].claude.hooks.enabled = true;
        settings['agents.providers'].claude.naming.enabled = false;
        settings['agents.notifications.enabled'] = true;
        settings['agents.notifications.completionThresholdSeconds'] = 0;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        await expect
            .poll(() => readFileIfPresent(join(config, 'settings.json')))
            .toContain('UserPromptSubmit');

        await running.app.evaluate(({ Notification }) => {
            type RecordedNotification = InstanceType<typeof Notification>;
            const state = globalThis as typeof globalThis & {
                __caxriAgentNotifications?: RecordedNotification[];
            };
            state.__caxriAgentNotifications = [];
            Notification.isSupported = () => true;
            Notification.prototype.show = function show(): void {
                // eslint-disable-next-line unicorn/no-this-outside-of-class -- prototype test seam
                state.__caxriAgentNotifications?.push(this);
            };
        });

        const sourceSessionId = await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'Fake Claude subagent lifecycle ready',
        );
        await writeFile(join(config, 'turn-started'), '', 'utf8');
        await waitForReceipt(join(config, 'turn-started.receipt'));
        const sourceRow = running.page.locator(`[data-session-id="${sourceSessionId}"]`);
        const sourceStatus = sourceRow.locator('.session-status');
        await expect(sourceStatus).toHaveAttribute('data-session-status', 'running');
        await expect(sourceStatus).toHaveAccessibleName('Working. The Agent is running.');

        await createAdditionalShellSession(running.page);
        await writeFile(join(config, 'subagent-finished'), '', 'utf8');
        await waitForReceipt(join(config, 'subagent-finished.receipt'));

        const afterSubagent = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            afterSubagent.sessions.find((session) => session.id === sourceSessionId),
        ).toMatchObject({
            attentionEpoch: 0,
            hasUnread: false,
            lastActivityState: 'running',
        });
        await expect(sourceStatus).toHaveAttribute('data-session-status', 'running');
        expect(
            await running.app.evaluate(() => {
                const state = globalThis as typeof globalThis & {
                    __caxriAgentNotifications?: unknown[];
                };
                return state.__caxriAgentNotifications?.length ?? 0;
            }),
        ).toBe(0);
        await running.page.screenshot({
            path: testInfo.outputPath('subagent-finished-session-still-running.png'),
        });

        await writeFile(join(config, 'parent-finished'), '', 'utf8');
        await waitForReceipt(join(config, 'parent-finished.receipt'));
        await expect
            .poll(async () => {
                const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                return bootstrap.sessions.find((session) => session.id === sourceSessionId);
            })
            .toMatchObject({
                attentionEpoch: 1,
                hasUnread: true,
                lastActivityState: 'completed',
                lastAttentionKind: 'completed',
            });
        await expect(sourceStatus).toHaveAttribute('data-session-status', 'attention');
        await expect
            .poll(() =>
                running.app.evaluate(() => {
                    interface RecordedNotification {
                        body: string;
                    }
                    const state = globalThis as typeof globalThis & {
                        __caxriAgentNotifications?: RecordedNotification[];
                    };
                    return (state.__caxriAgentNotifications ?? []).map(
                        (notification) => notification.body,
                    );
                }),
            )
            .toEqual(['Claude Code completed a turn.']);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
