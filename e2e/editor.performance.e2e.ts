import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { createProjectSession, launchCaxri } from './helpers.ts';

const preloadThresholdMs = 3_000;
const highlightThresholdMs = 250;

test('first TypeScript editor reports document, mount, and syntax-highlight latency', async () => {
    test.skip(
        !process.env.CAXRI_BENCHMARK_PROJECT_ROOT,
        'benchmark: set CAXRI_BENCHMARK_PROJECT_ROOT to run',
    );
    const projectRoot = resolve(process.env.CAXRI_BENCHMARK_PROJECT_ROOT!);
    const relativeFile = process.env.CAXRI_BENCHMARK_EDITOR_FILE ?? 'vitest.config.mts';
    const userData = await mkdtemp(join(tmpdir(), 'caxri-editor-benchmark-'));
    const running = await launchCaxri({ userDataDir: userData, testRootPath: projectRoot });

    try {
        await createProjectSession(running.page);
        await running.page.waitForFunction(
            () => performance.getEntriesByName('caxri.editor.preload').length === 1,
        );
        const preloadMs = await running.page.evaluate(
            () => performance.getEntriesByName('caxri.editor.preload')[0].duration,
        );
        const fileName = basename(relativeFile);
        const file = running.page.getByRole('button', { name: fileName, exact: true });
        await file.waitFor();
        await running.page.evaluate(() => {
            const benchmarkWindow = window as typeof window & {
                caxriFirstTypeScriptHighlight?: Promise<number>;
            };
            benchmarkWindow.caxriFirstTypeScriptHighlight = new Promise((resolve) => {
                const check = (): void => {
                    const openedAt = performance.getEntriesByName('caxri.editor.open-start').at(-1);
                    const line = [...document.querySelectorAll('.view-line')].find((element) =>
                        element.textContent?.includes('defineConfig'),
                    );
                    const tokens = line ? [...line.querySelectorAll('span span')] : [];
                    const colors = new Set(tokens.map((token) => getComputedStyle(token).color));
                    if (openedAt && tokens.length > 1 && colors.size > 1) {
                        resolve(performance.now() - openedAt.startTime);
                        return;
                    }
                    requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
            });
        });
        await file.click();

        const documentReadyMs = await expect
            .poll(() =>
                running.page.evaluate(
                    () =>
                        performance.getEntriesByName('caxri.editor.open-to-document').at(-1)
                            ?.duration,
                ),
            )
            .not.toBeUndefined()
            .then(() =>
                running.page.evaluate(
                    () =>
                        performance.getEntriesByName('caxri.editor.open-to-document').at(-1)!
                            .duration,
                ),
            );
        await running.page.waitForFunction(
            () => performance.getEntriesByName('caxri.editor.open-to-mount').length === 1,
        );
        const { beforeMountMs, editorReadyMs } = await running.page.evaluate(() => ({
            beforeMountMs: performance.getEntriesByName('caxri.editor.open-to-before-mount')[0]
                .duration,
            editorReadyMs: performance.getEntriesByName('caxri.editor.open-to-mount')[0].duration,
        }));
        const firstHighlightMs = await running.page.evaluate(async () => {
            const benchmarkWindow = window as typeof window & {
                caxriFirstTypeScriptHighlight?: Promise<number>;
            };
            if (!benchmarkWindow.caxriFirstTypeScriptHighlight)
                throw new Error('TypeScript highlight observer was not installed');
            return benchmarkWindow.caxriFirstTypeScriptHighlight;
        });
        const result = {
            projectRoot,
            relativeFile,
            preloadMs: Math.round(preloadMs),
            documentReadyMs: Math.round(documentReadyMs * 100) / 100,
            beforeMountMs: Math.round(beforeMountMs),
            editorReadyMs: Math.round(editorReadyMs),
            firstHighlightMs: Math.round(firstHighlightMs),
        };
        console.log(`CAXRI_EDITOR_BENCHMARK ${JSON.stringify(result)}`);

        expect(preloadMs).toBeLessThan(preloadThresholdMs);
        expect(documentReadyMs).toBeLessThan(highlightThresholdMs);
        expect(beforeMountMs).toBeLessThan(highlightThresholdMs);
        expect(editorReadyMs).toBeLessThan(highlightThresholdMs);
        expect(firstHighlightMs).toBeLessThan(highlightThresholdMs);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(userData, { recursive: true, force: true });
    }
});
