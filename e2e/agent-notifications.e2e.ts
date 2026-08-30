import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

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
        await expect
            .poll(() =>
                running.app.evaluate(({ BrowserWindow }) => {
                    const window = BrowserWindow.getAllWindows()[0];
                    return {
                        focused: window.isFocused(),
                        minimized: window.isMinimized(),
                        visible: window.isVisible(),
                    };
                }),
            )
            .toEqual({ focused: true, minimized: false, visible: true });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
