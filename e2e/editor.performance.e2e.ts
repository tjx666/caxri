import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
    createProjectSession,
    launchCaxri,
    launchCaxriApp,
    waitForRuntimeReady,
} from './helpers.ts';

const preloadThresholdMs = 3_000;
const highlightThresholdMs = 250;

interface EditorTiming {
    documentReadyMs: number;
    beforeMountMs: number;
    editorReadyMs: number;
    firstHighlightMs: number;
}

interface EditorScenarioTiming extends EditorTiming {
    preloadMs?: number;
    repeatHighlightMs: number;
}

type BenchmarkWindow = typeof window & {
    caxriFirstEditorHighlight?: Promise<number>;
    caxriReleaseIdleCallbacks?: () => void;
};

/** Keeps the benchmark on the real cold path until the first editor has visibly highlighted. */
async function holdIdleCallbacks(page: Page): Promise<void> {
    await page.evaluate(() => {
        const callbacks = new Map<number, IdleRequestCallback>();
        let nextCallbackId = 0;
        window.requestIdleCallback = (callback) => {
            nextCallbackId += 1;
            callbacks.set(nextCallbackId, callback);
            return nextCallbackId;
        };
        window.cancelIdleCallback = (callbackId) => callbacks.delete(callbackId);
        (window as BenchmarkWindow).caxriReleaseIdleCallbacks = () => {
            for (const callback of callbacks.values()) {
                callback({ didTimeout: false, timeRemaining: () => 50 });
            }
            callbacks.clear();
        };
    });
}

async function installHighlightObserver(page: Page, expectedText: string): Promise<void> {
    await page.evaluate((text) => {
        const previousOpen = performance.getEntriesByName('caxri.editor.open-start').at(-1);
        const benchmarkWindow = window as BenchmarkWindow;
        benchmarkWindow.caxriFirstEditorHighlight = new Promise((resolve) => {
            const check = (): void => {
                const openedAt = performance.getEntriesByName('caxri.editor.open-start').at(-1);
                const line = [...document.querySelectorAll('.monaco-editor .view-line')].find(
                    (element) => element.textContent?.includes(text),
                );
                const tokens = line ? [...line.querySelectorAll('span span')] : [];
                const colors = new Set(tokens.map((token) => getComputedStyle(token).color));
                if (
                    openedAt &&
                    openedAt.startTime !== previousOpen?.startTime &&
                    tokens.length > 1 &&
                    colors.size > 1
                ) {
                    resolve(performance.now() - openedAt.startTime);
                    return;
                }
                requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
        });
    }, expectedText);
}

async function measureFirstOpen(
    page: Page,
    fileName: string,
    expectedText: string,
): Promise<EditorTiming> {
    const file = page.getByRole('button', { name: fileName, exact: true });
    await file.waitFor();
    await installHighlightObserver(page, expectedText);
    await file.click();

    const documentReadyMs = await expect
        .poll(() =>
            page.evaluate(
                () =>
                    performance.getEntriesByName('caxri.editor.open-to-document').at(-1)?.duration,
            ),
        )
        .not.toBeUndefined()
        .then(() =>
            page.evaluate(
                () =>
                    performance.getEntriesByName('caxri.editor.open-to-document').at(-1)!.duration,
            ),
        );
    await page.waitForFunction(
        () => performance.getEntriesByName('caxri.editor.open-to-mount').length === 1,
    );
    const { beforeMountMs, editorReadyMs } = await page.evaluate(() => ({
        beforeMountMs: performance.getEntriesByName('caxri.editor.open-to-before-mount')[0]
            .duration,
        editorReadyMs: performance.getEntriesByName('caxri.editor.open-to-mount')[0].duration,
    }));
    const firstHighlightMs = await page.evaluate(async () => {
        const observer = (window as BenchmarkWindow).caxriFirstEditorHighlight;
        if (!observer) throw new Error('Editor highlight observer was not installed');
        return observer;
    });

    return { documentReadyMs, beforeMountMs, editorReadyMs, firstHighlightMs };
}

async function measureRepeatOpen(
    page: Page,
    fileName: string,
    detourFileName: string,
    expectedText: string,
): Promise<number> {
    await page.getByRole('button', { name: detourFileName, exact: true }).click();
    await expect
        .poll(() =>
            page.locator('.monaco-editor .view-line').filter({ hasText: expectedText }).count(),
        )
        .toBe(0);
    await installHighlightObserver(page, expectedText);
    await page.getByRole('button', { name: fileName, exact: true }).click();
    return page.evaluate(async () => {
        const observer = (window as BenchmarkWindow).caxriFirstEditorHighlight;
        if (!observer) throw new Error('Editor highlight observer was not installed');
        return observer;
    });
}

async function measureScenario(options: {
    detourFileName: string;
    expectedText: string;
    fileName: string;
    holdPreload: boolean;
    projectRoot: string;
}): Promise<EditorScenarioTiming> {
    const { detourFileName, expectedText, fileName, holdPreload, projectRoot } = options;
    const userData = await mkdtemp(join(tmpdir(), 'caxri-editor-benchmark-'));
    const running = holdPreload
        ? await launchCaxriApp({ userDataDir: userData, testRootPath: projectRoot })
        : await launchCaxri({ userDataDir: userData, testRootPath: projectRoot });

    try {
        if (holdPreload) {
            await holdIdleCallbacks(running.page);
            await waitForRuntimeReady(running.page);
        }
        await createProjectSession(running.page);

        let preloadMs: number | undefined;
        if (holdPreload) {
            expect(
                await running.page.evaluate(
                    () => performance.getEntriesByName('caxri.editor.preload').length,
                ),
            ).toBe(0);
        } else {
            await running.page.waitForFunction(
                () => performance.getEntriesByName('caxri.editor.preload').length === 1,
            );
            preloadMs = await running.page.evaluate(
                () => performance.getEntriesByName('caxri.editor.preload')[0].duration,
            );
        }

        const firstOpen = await measureFirstOpen(running.page, fileName, expectedText);
        if (holdPreload) {
            await running.page.evaluate(() =>
                (window as BenchmarkWindow).caxriReleaseIdleCallbacks?.(),
            );
        }
        const repeatHighlightMs = await measureRepeatOpen(
            running.page,
            fileName,
            detourFileName,
            expectedText,
        );
        return { ...firstOpen, preloadMs, repeatHighlightMs };
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(userData, { recursive: true, force: true });
    }
}

function roundTiming(timing: EditorScenarioTiming): EditorScenarioTiming {
    return {
        ...(timing.preloadMs === undefined ? {} : { preloadMs: Math.round(timing.preloadMs) }),
        documentReadyMs: Math.round(timing.documentReadyMs * 100) / 100,
        beforeMountMs: Math.round(timing.beforeMountMs),
        editorReadyMs: Math.round(timing.editorReadyMs),
        firstHighlightMs: Math.round(timing.firstHighlightMs),
        repeatHighlightMs: Math.round(timing.repeatHighlightMs),
    };
}

function expectWithinThreshold(timing: EditorScenarioTiming): void {
    expect(timing.documentReadyMs).toBeLessThan(highlightThresholdMs);
    expect(timing.beforeMountMs).toBeLessThan(highlightThresholdMs);
    expect(timing.editorReadyMs).toBeLessThan(highlightThresholdMs);
    expect(timing.firstHighlightMs).toBeLessThan(highlightThresholdMs);
    expect(timing.repeatHighlightMs).toBeLessThan(highlightThresholdMs);
}

test('cold and preloaded JavaScript or TypeScript editors report highlight latency', async () => {
    test.skip(
        !process.env.CAXRI_BENCHMARK_PROJECT_ROOT,
        'benchmark: set CAXRI_BENCHMARK_PROJECT_ROOT to run',
    );
    const projectRoot = resolve(process.env.CAXRI_BENCHMARK_PROJECT_ROOT!);
    const relativeFile = process.env.CAXRI_BENCHMARK_EDITOR_FILE ?? 'vitest.config.ts';
    const expectedText = process.env.CAXRI_BENCHMARK_EDITOR_TEXT ?? 'defineConfig';
    const detourFileName = process.env.CAXRI_BENCHMARK_EDITOR_DETOUR_FILE ?? 'package.json';
    const fileName = basename(relativeFile);

    const cold = await measureScenario({
        detourFileName,
        expectedText,
        fileName,
        holdPreload: true,
        projectRoot,
    });
    const preloaded = await measureScenario({
        detourFileName,
        expectedText,
        fileName,
        holdPreload: false,
        projectRoot,
    });
    const result = {
        projectRoot,
        relativeFile,
        cold: roundTiming(cold),
        preloaded: roundTiming(preloaded),
    };
    console.log(`CAXRI_EDITOR_BENCHMARK ${JSON.stringify(result)}`);

    expect(preloaded.preloadMs).toBeLessThan(preloadThresholdMs);
    expectWithinThreshold(cold);
    expectWithinThreshold(preloaded);
});
