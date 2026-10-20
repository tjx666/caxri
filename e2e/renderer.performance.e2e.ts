import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';
import type { RendererPerformanceWindow } from './support/renderer-performance.ts';

type RendererPerformanceSurface = keyof RendererPerformanceScenarioDiagnostic['react']['surfaces'];

interface RendererSurfaceBudget {
    maximumRenderCount: number;
    maximumTotalDurationMs: number;
}

/**
 * Scenario-specific ceilings calibrated from repeated profiling runs. A 100 ms frame gap is a visible freeze; tighter
 * refresh-rate-derived frame budgets and LoAF values stay diagnostic because runner load makes them noisy.
 */
const rendererSurfaceBudgets = {
    'primary-sidebar': { maximumRenderCount: 12, maximumTotalDurationMs: 8 },
    'workbench': { maximumRenderCount: 8, maximumTotalDurationMs: 6 },
    'secondary-sidebar': { maximumRenderCount: 6, maximumTotalDurationMs: 5 },
} as const satisfies Record<RendererPerformanceSurface, RendererSurfaceBudget>;

const representativeSessionCount = 8;

async function seedRepresentativeProject(projectRoot: string): Promise<void> {
    const directories = [
        'src/features/session',
        'src/features/editor',
        'src/components',
        'tests/integration',
        'docs/guides',
    ];
    await Promise.all(
        directories.map((directory) => mkdir(join(projectRoot, directory), { recursive: true })),
    );
    const files = Array.from({ length: 30 }, (_, index) => {
        const directory = directories[index % directories.length];
        return writeFile(
            join(projectRoot, directory, `fixture-${String(index + 1).padStart(2, '0')}.ts`),
            `export const fixture${index + 1} = ${index + 1};\n`,
            'utf8',
        );
    });
    await Promise.all(files);
}

async function createRepresentativeSessions(page: Page): Promise<string[]> {
    const sessionIds = [await createProjectSession(page)];
    while (sessionIds.length < representativeSessionCount) {
        // Session creation is intentionally serial because each accessible action targets the newly selected Session.
        // eslint-disable-next-line no-await-in-loop -- see above
        await createAdditionalShellSession(page);
        // eslint-disable-next-line no-await-in-loop -- see above
        sessionIds.push(await selectedSessionId(page));
    }
    const state = await pageRequest<{ sessions: Array<{ id: string }> }>(page, 'app.bootstrap');
    expect(state.sessions).toHaveLength(representativeSessionCount);
    /**
     * The PrimarySidebar only renders a Project's five most recent Sessions until the reveal row is activated. The
     * representative workload is the full list on screen, so reveal it here; the surface budgets above are calibrated
     * against that row count, and the scenario also switches to the oldest Session, which the default window hides.
     */
    const revealMore = page.locator('.session-reveal');
    if ((await revealMore.count()) > 0) await revealMore.click();
    await expect(page.locator('.session-list .session-card')).toHaveCount(
        representativeSessionCount,
    );
    return sessionIds;
}

async function expandRepresentativeFileTree(page: Page): Promise<void> {
    const fileTree = page.locator('.file-list').first();
    const sourceDirectory = fileTree.getByRole('treeitem', { exact: true, name: 'src' });
    await expect(sourceDirectory).toBeVisible();
    if ((await sourceDirectory.getAttribute('aria-expanded')) !== 'true')
        await sourceDirectory.click();
    const featuresDirectory = fileTree.getByRole('treeitem', { exact: true, name: 'features' });
    await expect(featuresDirectory).toBeVisible();
    if ((await featuresDirectory.getAttribute('aria-expanded')) !== 'true')
        await featuresDirectory.click();
    await expect(fileTree.getByRole('treeitem', { exact: true, name: 'session' })).toBeVisible();
}

test('profiling build gates one representative Session switch', async () => {
    test.skip(
        process.env.CAXRI_RENDERER_BENCHMARK !== '1',
        'benchmark: run through bun run benchmark:renderer',
    );
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-renderer-benchmark-'));
    const userDataDirectory = join(testDirectory, 'user-data');
    const projectRoot = join(testDirectory, 'project');
    await mkdir(projectRoot);
    await seedRepresentativeProject(projectRoot);
    const running = await launchCaxri({
        userDataDir: userDataDirectory,
        testRootPath: projectRoot,
        windowMode: 'visible',
    });

    try {
        const sessionIds = await createRepresentativeSessions(running.page);
        const targetSessionId = sessionIds[0];
        const sourceSessionId = sessionIds.at(-1)!;
        const bootstrap = await pageRequest<{
            terminals: Array<{ id: string; sessionId: string }>;
        }>(running.page, 'app.bootstrap');
        const targetTerminalId = bootstrap.terminals.find(
            (terminal) => terminal.sessionId === targetSessionId,
        )?.id;
        if (!targetTerminalId) throw new Error('Representative target Terminal is unavailable');

        await sessionCard(running.page, targetSessionId).click();
        await expect.poll(() => selectedSessionId(running.page)).toBe(targetSessionId);
        await expandRepresentativeFileTree(running.page);
        await sessionCard(running.page, sourceSessionId).click();
        await expect.poll(() => selectedSessionId(running.page)).toBe(sourceSessionId);
        await expandRepresentativeFileTree(running.page);

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
            return performanceApi.begin('session.switch');
        });
        await expect
            .poll(() =>
                running.page.evaluate(
                    () =>
                        (globalThis as RendererPerformanceWindow).caxriPerformance?.status()
                            .frameSampleCount ?? 0,
                ),
            )
            .toBeGreaterThanOrEqual(1);
        await sessionCard(running.page, targetSessionId).click();
        await expect(sessionCard(running.page, targetSessionId)).toHaveClass(/active/u);
        await expect(
            running.page.locator(`.terminal-pane[data-terminal-id="${targetTerminalId}"]`),
        ).toBeVisible();
        await expect(
            running.page
                .locator('.file-list')
                .first()
                .getByRole('treeitem', { exact: true, name: 'session' }),
        ).toBeVisible();
        await running.page.evaluate(
            () =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }),
        );
        await expect
            .poll(() =>
                running.page.evaluate(
                    () =>
                        (globalThis as RendererPerformanceWindow).caxriPerformance?.status()
                            .pendingRequestCount ?? 0,
                ),
            )
            .toBe(0);

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
        expect(receipt.action).toBe('session.switch');
        expect(receipt.buildMode).toBe('profiling');
        expect(receipt.documentVisible).toBe(true);
        expect(receipt.documentFocused).toBe(true);
        expect(receipt.visibilityInterrupted).toBe(false);
        expect(receipt.focusInterrupted).toBe(false);
        expect(receipt.capabilities.reactProfiler).toBe('available');
        expect(receipt.react.commitCount).toBeGreaterThan(0);
        expect(receipt.react.profiledRenderCount).toBeGreaterThan(0);
        expect(receipt.frames.sampleCount).toBeGreaterThanOrEqual(1);
        expect(receipt.frames.maxIntervalMs).toBeLessThan(100);
        expect(receipt.durationMs).toBeLessThan(500);
        expect(receipt.truncated).toBe(false);
        expect(receipt.requests.sessionSelect.count).toBe(1);
        expect(receipt.requests.sessionSelect.maxDurationMs).toBeLessThan(100);
        expect(receipt.requests.appBootstrap.count).toBe(1);
        expect(receipt.requests.appBootstrap.maxDurationMs).toBeLessThan(100);
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
        expect(receipt.capabilities).not.toHaveProperty('reactScan');
        expect(receipt).not.toHaveProperty('reactScan');

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
                        receipt.react.surfaces['secondary-sidebar'].profiledRenderCount &&
                    record.fields.sessionSelectRequestCount ===
                        receipt.requests.sessionSelect.count &&
                    record.fields.appBootstrapRequestCount === receipt.requests.appBootstrap.count
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
