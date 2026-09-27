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
/**
 * `AGENT_METADATA_REFRESH_DELAY_MS` (2 seconds) in the Server's Agent coordinator, plus slack for the probe itself.
 */
const TRAILING_PROBE_SETTLE_MS = 2_500;

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
        /**
         * A fake turn ends immediately, so the completion threshold would otherwise suppress the notification this test
         * is about. Claude Code's `idle` metadata reads as a finished turn, which is threshold-gated exactly like every
         * other provider's completion.
         */
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        const thresholdSettings = structuredClone(currentSettings.value);
        thresholdSettings['agents.notifications.completionThresholdSeconds'] = 0;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(thresholdSettings, null, 2),
        });
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
                    // The fake Claude writes no transcript, so the reply summary falls back to the duration line.
                    body: expect.stringMatching(/^Finished in \d+[hms]/u),
                    groupId: 'caxri-agent-sessions',
                    id: `caxri-agent-session-${sourceSessionId}`,
                    title: `Claude Code · ${SESSION_TITLE}`,
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
test('a Claude parent completion waits for its background subagent before notifying', async ({}, testInfo) => {
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
  ['subagent-started', 'SubagentStart', { agent_id: 'subagent-1' }],
  ['parent-finished', 'Stop', {}],
  ['subagent-finished', 'SubagentStop', { agent_id: 'subagent-1' }],
  ['parent-resumed', 'UserPromptSubmit', {}],
  ['resumed-finished', 'Stop', {}],
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
    // A real Claude prints while it works; this output schedules the trailing metadata probe the test races against.
    process.stdout.write('hook ' + name + '\r\n');
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
        /**
         * The fake never writes Claude session metadata, so the trailing probe scheduled 2 seconds after PTY output
         * reads `unknown`. Waiting here lands that probe between `turnStarted` and the parent's `Stop`, the only window
         * in which the Server used to let it demote the hook-established `running` (issue #568). The scheduler is a
         * throttle, so the wait must sit inside the window: once `Stop` restores hook authority the same probe is
         * preserved, which is why the original case only failed on a machine slower than the delay.
         */
        await running.page.waitForTimeout(TRAILING_PROBE_SETTLE_MS);
        const sourceRow = running.page.locator(`[data-session-id="${sourceSessionId}"]`);
        const sourceStatus = sourceRow.locator('.session-status');
        await expect(sourceStatus).toHaveAttribute('data-session-status', 'running');
        await expect(sourceStatus).toHaveAccessibleName('Working. The Agent is running.');

        await writeFile(join(config, 'subagent-started'), '', 'utf8');
        await waitForReceipt(join(config, 'subagent-started.receipt'));
        await createAdditionalShellSession(running.page);
        await writeFile(join(config, 'parent-finished'), '', 'utf8');
        await waitForReceipt(join(config, 'parent-finished.receipt'));

        const afterParent = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            afterParent.sessions.find((session) => session.id === sourceSessionId),
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
            path: testInfo.outputPath('parent-finished-subagent-still-running.png'),
        });

        /**
         * Real Claude Code resumes the parent turn on its own right after `SubagentStop`, so the last child stopping
         * must not settle the Session or notify; only the resumed turn's `Stop` does.
         */
        await writeFile(join(config, 'subagent-finished'), '', 'utf8');
        await waitForReceipt(join(config, 'subagent-finished.receipt'));
        await writeFile(join(config, 'parent-resumed'), '', 'utf8');
        await waitForReceipt(join(config, 'parent-resumed.receipt'));
        const afterSubagent = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            afterSubagent.sessions.find((session) => session.id === sourceSessionId),
        ).toMatchObject({
            attentionEpoch: 0,
            hasUnread: false,
            lastActivityState: 'running',
        });
        expect(
            await running.app.evaluate(() => {
                const state = globalThis as typeof globalThis & {
                    __caxriAgentNotifications?: unknown[];
                };
                return state.__caxriAgentNotifications?.length ?? 0;
            }),
        ).toBe(0);

        await writeFile(join(config, 'resumed-finished'), '', 'utf8');
        await waitForReceipt(join(config, 'resumed-finished.receipt'));
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
            .toEqual([expect.stringMatching(/^Finished in \d+[hms]/u)]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
