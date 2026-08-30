import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

interface RendererPerformanceBrowserApi {
    begin(action: 'benchmark.renderer'): string;
    end(scenarioId: string): RendererPerformanceScenarioDiagnostic;
    status(): { frameSampleCount: number; scenarioId: string | null };
}

type RendererPerformanceWindow = typeof globalThis & {
    caxriPerformance?: RendererPerformanceBrowserApi;
};

type RendererPerformanceSurface = keyof RendererPerformanceScenarioDiagnostic['react']['surfaces'];

interface RendererSurfaceBudget {
    maximumRenderCount: number;
    maximumTotalDurationMs: number;
}

/**
 * Scenario-specific ceilings calibrated from repeated profiling runs. Browser frame and LoAF values stay diagnostic
 * because refresh rate and runner load make them unsuitable for the deterministic gate.
 */
const rendererSurfaceBudgets = {
    'primary-sidebar': { maximumRenderCount: 140, maximumTotalDurationMs: 50 },
    'workbench': { maximumRenderCount: 60, maximumTotalDurationMs: 30 },
    'secondary-sidebar': { maximumRenderCount: 45, maximumTotalDurationMs: 20 },
} as const satisfies Record<RendererPerformanceSurface, RendererSurfaceBudget>;

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
        const firstSessionId = await createProjectSession(running.page);
        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
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
            // Sequential by design: every interaction waits for the preceding React commit.
            // eslint-disable-next-line no-await-in-loop -- see above
            await sessionCard(running.page, firstSessionId).click();
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect.poll(() => selectedSessionId(running.page)).toBe(firstSessionId);
            // eslint-disable-next-line no-await-in-loop -- see above
            await sessionCard(running.page, secondSessionId).click();
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect.poll(() => selectedSessionId(running.page)).toBe(secondSessionId);
            // Sequential by design: each interaction must observe the previous committed state.
            // eslint-disable-next-line no-await-in-loop -- see above
            await disclosure.click();
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
            // eslint-disable-next-line no-await-in-loop -- see above
            await disclosure.click();
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
            // eslint-disable-next-line no-await-in-loop -- each shortcut must commit before the next
            await running.page.keyboard.press('Meta+[');
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(running.page.locator('.session-primary-sidebar')).toHaveCount(0);
            // eslint-disable-next-line no-await-in-loop -- see above
            await running.page.keyboard.press('Meta+[');
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(running.page.locator('.session-primary-sidebar')).toBeVisible();
            // eslint-disable-next-line no-await-in-loop -- see above
            await running.page.keyboard.press('Meta+]');
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(running.page.locator('.secondary-sidebar')).toHaveCount(0);
            // eslint-disable-next-line no-await-in-loop -- see above
            await running.page.keyboard.press('Meta+]');
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(running.page.locator('.secondary-sidebar')).toBeVisible();
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
        const receiptDirectory = join(process.cwd(), 'test-results', 'receipts');
        await mkdir(receiptDirectory, { recursive: true });
        await writeFile(
            join(receiptDirectory, 'renderer-performance.json'),
            `${JSON.stringify(receipt, null, 2)}\n`,
            'utf8',
        );
        process.stdout.write(`CAXRI_RENDERER_BENCHMARK ${JSON.stringify(receipt)}\n`);

        expect(receipt.kind).toBe('renderer-performance-scenario');
        expect(receipt.buildMode).toBe('profiling');
        expect(receipt.documentVisible).toBe(true);
        expect(receipt.documentFocused).toBe(true);
        expect(receipt.visibilityInterrupted).toBe(false);
        expect(receipt.focusInterrupted).toBe(false);
        expect(receipt.capabilities.reactProfiler).toBe('available');
        expect(receipt.react.commitCount).toBeGreaterThan(0);
        expect(receipt.react.profiledRenderCount).toBeGreaterThan(0);
        expect(receipt.frames.sampleCount).toBeGreaterThanOrEqual(9);
        expect(receipt.durationMs).toBeLessThan(10_000);
        expect(receipt.truncated).toBe(false);
        for (const [surface, budget] of Object.entries(rendererSurfaceBudgets)) {
            const summary = receipt.react.surfaces[surface as RendererPerformanceSurface];
            expect(summary.profiledRenderCount, `${surface} did not render`).toBeGreaterThan(0);
            expect(
                summary.profiledRenderCount,
                `${surface} rendered too often`,
            ).toBeLessThanOrEqual(budget.maximumRenderCount);
            expect(
                summary.actualDurationTotalMs,
                `${surface} exceeded its total React render budget`,
            ).toBeLessThanOrEqual(budget.maximumTotalDurationMs);
        }
        if (process.env.CAXRI_RENDERER_MONITORING === '1') {
            expect(['active', 'commit-tree-only']).toContain(receipt.capabilities.reactScan);
            if (receipt.capabilities.reactScan === 'active') {
                expect(receipt.reactScan.commitCount).toBeGreaterThan(0);
                expect(receipt.reactScan.renderCount).toBeGreaterThan(0);
            }
        } else {
            expect(receipt.capabilities.reactScan).toBe('disabled');
            expect(receipt.reactScan.commitCount).toBe(0);
            expect(receipt.reactScan.renderCount).toBe(0);
        }

        const desktopLog = join(userDataDirectory, 'logs', 'desktop.jsonl');
        await expect
            .poll(async () => {
                let contents: string;
                try {
                    contents = await readFile(desktopLog, 'utf8');
                } catch {
                    return false;
                }
                const record = contents
                    .split('\n')
                    .filter(Boolean)
                    .map(
                        (line) =>
                            JSON.parse(line) as {
                                correlationId?: string;
                                event?: string;
                                fields?: Record<string, unknown>;
                            },
                    )
                    .find(
                        (record) =>
                            record.event === 'renderer.performance_scenario' &&
                            record.correlationId === scenarioId,
                    );
                return record?.fields?.reactPrimarySidebarRenderCount ===
                    receipt.react.surfaces['primary-sidebar'].profiledRenderCount &&
                    record.fields.reactWorkbenchRenderCount ===
                        receipt.react.surfaces.workbench.profiledRenderCount &&
                    record.fields.reactSecondarySidebarRenderCount ===
                        receipt.react.surfaces['secondary-sidebar'].profiledRenderCount
                    ? record.fields
                    : false;
            })
            .toBeTruthy();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during benchmark cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
