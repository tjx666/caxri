/* eslint-disable no-await-in-loop -- Setup and samples share one interactive Electron window and must execute in order. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import type { RendererPerformanceWindow } from './support/renderer-performance.ts';

test('measures switching until the target Session Chat history is painted', async () => {
    test.skip(
        process.env.CAXRI_RENDERER_BENCHMARK !== '1',
        'benchmark: run through bun run benchmark:renderer',
    );
    const directory = await mkdtemp(join(tmpdir(), 'caxri-chat-switch-benchmark-'));
    const root = join(directory, 'project');
    const userData = join(directory, 'profile');
    await mkdir(join(root, 'src'), { recursive: true });
    await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
            writeFile(
                join(root, 'src', `example-${index}.ts`),
                `export const example = ${index};\n`,
            ),
        ),
    );
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({
        agentMode,
        testRootPath: root,
        userDataDir: userData,
        windowMode: 'visible',
    });
    try {
        const { page } = running;
        const targets: Array<{ id: string; marker: string }> = [];
        await createProjectSession(page, 'shell');
        for (const name of ['alpha', 'beta']) {
            if (targets.length > 0) await createAdditionalShellSession(page);
            await openAgentChat(page, 'Codex Chat');
            const chat = page.locator(VISIBLE_SESSION);
            for (let index = 0; index < 3; index++) {
                const text = `table please ${name} ${index}`;
                await chat.getByRole('textbox', { name: 'Message' }).fill(text);
                await chat.getByRole('textbox', { name: 'Message' }).press('Enter');
                await expect(chat.getByRole('table')).toHaveCount(index + 1);
                await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(
                    0,
                );
            }
            targets.push({ id: await selectedSessionId(page), marker: `table please ${name} 2` });
        }
        const samples: RendererPerformanceScenarioDiagnostic[] = [];
        for (let index = 0; index < 6; index++) {
            const target = targets[index % targets.length];
            const scenarioId = await page.evaluate(() => {
                const api = (globalThis as RendererPerformanceWindow).caxriPerformance;
                if (!api) throw new Error('Renderer performance API unavailable');
                return api.begin('session.switch');
            });
            await sessionCard(page, target.id).click();
            await expect(sessionCard(page, target.id)).toHaveClass(/active/u);
            const chat = page.locator(VISIBLE_SESSION);
            await expect(
                chat.getByRole('log').getByText(target.marker, { exact: true }),
            ).toBeVisible();
            await expect(chat.getByRole('table')).toHaveCount(3);
            // History visibility, then two presentation frames: an active sidebar row alone is not Chat readiness.
            await page.evaluate(
                () =>
                    new Promise<void>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    ),
            );
            const receipt = await page.evaluate((id) => {
                const api = (globalThis as RendererPerformanceWindow).caxriPerformance;
                if (!api) throw new Error('Renderer performance API unavailable');
                return api.end(id);
            }, scenarioId);
            expect(receipt.buildMode).toBe('profiling');
            expect(receipt.visibilityInterrupted).toBe(false);
            expect(receipt.focusInterrupted).toBe(false);
            expect(receipt.react.commitCount).toBeGreaterThan(0);
            samples.push(receipt);
        }
        const durations = samples
            .map((sample) => sample.durationMs)
            .toSorted((left, right) => left - right);
        const result = {
            kind: 'agent-chat-switch-benchmark',
            sampleCount: samples.length,
            medianMs:
                (durations[Math.floor((durations.length - 1) / 2)] +
                    durations[Math.floor(durations.length / 2)]) /
                2,
            p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
            samples,
        };
        const output = join(process.cwd(), 'test-results', 'receipts');
        await mkdir(output, { recursive: true });
        await writeFile(
            join(output, 'agent-chat-switch.json'),
            `${JSON.stringify(result, null, 2)}\n`,
        );
        process.stdout.write(`CAXRI_AGENT_CHAT_SWITCH_BENCHMARK ${JSON.stringify(result)}\n`);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
/* eslint-enable no-await-in-loop */
