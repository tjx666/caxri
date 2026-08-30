import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

interface RendererPerformanceBrowserApi {
    begin(action: 'benchmark.renderer'): string;
    end(scenarioId: string): RendererPerformanceScenarioDiagnostic;
    status(): { frameSampleCount: number; scenarioId: string | null };
}

type RendererPerformanceWindow = typeof globalThis & {
    caxriPerformance?: RendererPerformanceBrowserApi;
};

test('profiling build emits a bounded Renderer performance receipt', async () => {
    test.skip(
        process.env.CAXRI_RENDERER_BENCHMARK !== '1',
        'benchmark: run through bun run benchmark:renderer',
    );
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-renderer-benchmark-'));
    const userDataDirectory = join(testDirectory, 'user-data');
    const projectRoot = join(testDirectory, 'project');
    await mkdir(projectRoot);
    const running = await launchCaxri({
        userDataDir: userDataDirectory,
        testRootPath: projectRoot,
        windowMode: 'visible',
    });

    try {
        await createProjectSession(running.page);
        const invalidActionError = await running.page.evaluate(() => {
            const performanceApi = (globalThis as RendererPerformanceWindow).caxriPerformance;
            if (!performanceApi) throw new Error('Renderer performance API is unavailable');
            try {
                performanceApi.begin('private.action' as never);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        });
        expect(invalidActionError).toBe('Unsupported Renderer performance action');
        const scenarioId = await running.page.evaluate(() => {
            const performanceApi = (globalThis as RendererPerformanceWindow).caxriPerformance;
            if (!performanceApi) throw new Error('Renderer performance API is unavailable');
            return performanceApi.begin('benchmark.renderer');
        });
        await expect
            .poll(() =>
                running.page.evaluate(
                    () =>
                        (globalThis as RendererPerformanceWindow).caxriPerformance?.status()
                            .frameSampleCount ?? 0,
                ),
            )
            .toBeGreaterThanOrEqual(3);

        const disclosure = running.page.locator('.project-disclosure');
        for (let iteration = 0; iteration < 3; iteration += 1) {
            // Sequential by design: each interaction must observe the previous committed state.
            // eslint-disable-next-line no-await-in-loop -- see above
            await disclosure.click();
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
            // eslint-disable-next-line no-await-in-loop -- see above
            await disclosure.click();
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
        }
        await expect
            .poll(() =>
                running.page.evaluate(
                    () =>
                        (globalThis as RendererPerformanceWindow).caxriPerformance?.status()
                            .frameSampleCount ?? 0,
                ),
            )
            .toBeGreaterThanOrEqual(10);

        const receipt = await running.page.evaluate((id) => {
            const performanceApi = (globalThis as RendererPerformanceWindow).caxriPerformance;
            if (!performanceApi) throw new Error('Renderer performance API is unavailable');
            return performanceApi.end(id);
        }, scenarioId);

        expect(receipt.kind).toBe('renderer-performance-scenario');
        expect(receipt.buildMode).toBe('profiling');
        expect(receipt.documentVisible).toBe(true);
        expect(receipt.documentFocused).toBe(true);
        expect(receipt.visibilityInterrupted).toBe(false);
        expect(receipt.focusInterrupted).toBe(false);
        expect(receipt.capabilities.reactProfiler).toBe('available');
        expect(receipt.capabilities.reactScan).not.toBe('disabled');
        expect(receipt.react.commitCount).toBeGreaterThan(0);
        expect(receipt.react.profiledRenderCount).toBeGreaterThan(0);
        expect(receipt.frames.sampleCount).toBeGreaterThanOrEqual(9);
        expect(receipt.reactScan.commitCount).toBeGreaterThan(0);
        expect(receipt.reactScan.renderCount).toBeGreaterThan(0);
        expect(receipt.durationMs).toBeLessThan(10_000);
        expect(receipt.react.actualDurationP95Ms).toBeLessThan(100);
        expect(receipt.frames.intervalP95Ms).toBeLessThan(100);
        expect(receipt.longAnimationFrames.maxDurationMs).toBeLessThan(500);

        const desktopLog = join(userDataDirectory, 'logs', 'desktop.jsonl');
        await expect
            .poll(async () => {
                let contents: string;
                try {
                    contents = await readFile(desktopLog, 'utf8');
                } catch {
                    return false;
                }
                return contents
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as { correlationId?: string; event?: string })
                    .some(
                        (record) =>
                            record.event === 'renderer.performance_scenario' &&
                            record.correlationId === scenarioId,
                    );
            })
            .toBe(true);

        process.stdout.write(`CAXRI_RENDERER_BENCHMARK ${JSON.stringify(receipt)}\n`);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during benchmark cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
