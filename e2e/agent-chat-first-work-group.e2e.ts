import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionCompactionResult } from '@caxri/protocol';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture';
import { expect, test } from './support/fixtures';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
} from './support/helpers';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('ordinary tools share one summary from their first visible frame', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-first-work-'));
    const root = join(directory, 'project');
    const userData = join(directory, 'profile');
    await mkdir(root);
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const samples = await page.evaluateHandle(() => {
            const state = { running: true, groups: [] as string[][] };
            const sample = () => {
                const groups = [
                    ...document.querySelectorAll<HTMLElement>(
                        '.workbench-session:not([hidden]) [data-disclosure="agent-chat-work-group"]',
                    ),
                ].filter(
                    (element) => (element.parentElement?.getBoundingClientRect().height ?? 0) > 0,
                );
                if (groups.length > 0) state.groups.push(groups.map(({ id }) => id));
                if (state.running) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            return state;
        });
        await session.getByRole('textbox', { name: 'Message' }).fill('explore gradual');
        await session.getByRole('textbox', { name: 'Message' }).press('Enter');
        const summary = session.locator('[data-disclosure="agent-chat-work-group"]');
        await expect(summary).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath('first-tool-summary.png') });
        await expect(session.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        const frames = await samples.evaluate((state) => {
            state.running = false;
            return state.groups;
        });
        expect(frames.length).toBeGreaterThan(1);
        expect(frames.every((groups) => groups.length === 1)).toBe(true);
        expect(new Set(frames.flat()).size).toBe(1);
        await testInfo.attach('first-frame-group-counts', {
            body: JSON.stringify({
                frames: frames.length,
                groupsPerFrame: 1,
                stableGroupIdentity: true,
            }),
            contentType: 'application/json',
        });
        await page.screenshot({ path: testInfo.outputPath('completed-tool-summary.png') });
        await session.getByRole('textbox', { name: 'Message' }).fill('testrun');
        await session.getByRole('textbox', { name: 'Message' }).press('Enter');
        await expect(session.getByText('One test fails in', { exact: false })).toBeVisible();
        await expect(session.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        await session.getByRole('button', { name: 'Worked', exact: true }).last().click();
        await summary.last().locator('..').getByRole('button').first().click();
        await expect(summary.last()).toHaveAttribute('data-expanded', 'true');
        await expect(summary.last().getByText('npm test', { exact: false })).toBeVisible();
        await expect
            .poll(() =>
                summary
                    .last()
                    .evaluate(
                        (element) =>
                            element.getBoundingClientRect().height + 1 >= element.scrollHeight &&
                            element.scrollHeight > 0,
                    ),
            )
            .toBe(true);
        await page.screenshot({
            path: testInfo.outputPath('short-success-failed-command-times.png'),
        });
        await session.getByRole('textbox', { name: 'Message' }).fill('contextpressure');
        await session.getByRole('textbox', { name: 'Message' }).press('Enter');
        await expect(
            session.getByText('Hello from fake Codex. You said: contextpressure'),
        ).toBeVisible();
        await expect(session.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        const nativeFiles = await readdir(agentMode.environment.CODEX_HOME!, { recursive: true });
        expect(nativeFiles.filter((file) => file.includes('rollout-'))).not.toHaveLength(0);
        const maintenance = await pageRequest<SessionCompactionResult>(
            page,
            'session.compactWarm',
            {},
        );
        expect(maintenance.items).toEqual(
            expect.arrayContaining([expect.objectContaining({ outcome: 'submitted' })]),
        );
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
