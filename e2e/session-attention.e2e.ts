import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    waitForRuntimeReady,
} from './helpers.ts';

interface SessionSummary {
    attentionEpoch: number;
    hasUnread: boolean;
    id: string;
    lastActivityState: string;
}

async function writeClaudeMetadata(
    configDirectory: string,
    root: string,
    startedAt: number,
    status: 'busy' | 'idle' | 'completed',
    name: string,
): Promise<void> {
    const sessions = join(configDirectory, 'sessions');
    const target = join(sessions, 'session.json');
    const temporary = join(sessions, 'session.next.json');
    await writeFile(
        temporary,
        JSON.stringify({
            cwd: root,
            name,
            sessionId: 'claude-attention-session',
            startedAt: new Date(startedAt).toISOString(),
            status,
            updatedAt: new Date().toISOString(),
        }),
        'utf8',
    );
    await rename(temporary, target);
    await writeFile(join(configDirectory, 'trigger'), String(Date.now()), 'utf8');
}

test('Session attention persists until the selected Session is visibly focused', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-attention-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const config = join(testDirectory, 'claude');
    const bin = join(testDirectory, 'bin');
    const executable = join(bin, 'claude');
    await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(join(config, 'sessions'), { recursive: true }),
        mkdir(bin, { recursive: true }),
    ]);
    await writeFile(
        executable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'claude-test 1.0\\n'
  exit 0
fi
printf 'Fake Claude ready\\n'
while true; do
  if [ -f "$CLAUDE_CONFIG_DIR/trigger" ]; then
    /bin/rm -f "$CLAUDE_CONFIG_DIR/trigger"
    printf 'metadata changed\\n'
  fi
  sleep 0.05
done
`,
        'utf8',
    );
    await chmod(executable, 0o700);
    const launchOptions = {
        userDataDir: userData,
        testRootPath: root,
        env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            CLAUDE_CONFIG_DIR: config,
        },
    };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page, 'claude');
        const initial = await pageRequest<{ sessions: SessionSummary[] }>(
            running.page,
            'app.bootstrap',
        );
        const firstSession = initial.sessions[0];
        const startedAt = Date.now();
        await writeClaudeMetadata(config, root, startedAt, 'busy', 'First Agent');
        await expect
            .poll(async () => {
                const state = await pageRequest<{ sessions: SessionSummary[] }>(
                    running.page,
                    'app.bootstrap',
                );
                return state.sessions.find((session) => session.id === firstSession.id)
                    ?.lastActivityState;
            })
            .toBe('running');

        await createAdditionalShellSession(running.page);
        const withSecond = await pageRequest<{
            selectedSessionId: string;
            sessions: SessionSummary[];
        }>(running.page, 'app.bootstrap');
        const secondSessionId = withSecond.selectedSessionId;
        expect(secondSessionId).not.toBe(firstSession.id);

        await writeClaudeMetadata(config, root, startedAt, 'idle', 'First Agent');
        const firstRow = running.page.locator(`[data-session-id="${firstSession.id}"]`);
        await expect(firstRow.getByRole('img', { name: 'Unread: Waiting for you' })).toBeVisible();
        await expect(
            firstRow.getByRole('img', { name: 'Waiting for you', exact: true }),
        ).toBeVisible();

        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .getByRole('img', { name: 'Unread: Waiting for you' }),
        ).toBeVisible();

        await running.page
            .getByRole('button', { name: /^Open Process Explorer — Terminal memory:/ })
            .click();
        await expect.poll(() => running.app.windows().length).toBe(2);
        const processPage = running.app.windows().find((page) => page !== running.page)!;
        await processPage.waitForLoadState('domcontentloaded');
        await expect.poll(() => processPage.evaluate(() => document.hasFocus())).toBe(true);
        /** Playwright focus emulation reports both Electron pages as focused; align the main
            document with the real native focus owner while Process Explorer is in front. */
        await running.page.evaluate(() =>
            Object.defineProperty(document, 'hasFocus', {
                configurable: true,
                value: () => false,
            }),
        );
        await pageRequest(running.page, 'session.select', { sessionId: firstSession.id });
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .getByRole('img', { name: 'Unread: Waiting for you' }),
        ).toBeVisible();

        await running.page.evaluate(() => Reflect.deleteProperty(document, 'hasFocus'));
        await running.page.bringToFront();
        await running.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect
            .poll(() =>
                running.page.evaluate(
                    () => document.visibilityState === 'visible' && document.hasFocus(),
                ),
            )
            .toBe(true);
        await expect(
            running.page.locator(`[data-session-id="${firstSession.id}"] .session-unread`),
        ).toHaveCount(0);

        await pageRequest(running.page, 'session.select', { sessionId: secondSessionId });
        await writeClaudeMetadata(config, root, startedAt, 'completed', 'First Agent');
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .getByRole('img', { name: 'Unread: Finished' }),
        ).toBeVisible();

        await running.app.close();
        running = await launchCaxri(launchOptions);
        await expect(
            running.page
                .locator(`[data-session-id="${firstSession.id}"]`)
                .getByRole('img', { name: 'Unread: Finished' }),
        ).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
