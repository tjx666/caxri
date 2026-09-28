import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
);

/**
 * E2E failure evidence is published as GitHub Actions artifacts, so the upload set stays bounded: the pool receipts
 * plus, for a failed pool, that pool's own Playwright output directory (issue #1446).
 */
describe('CI E2E failure artifacts', () => {
    it('uploads bounded receipts plus only the failed pool output for E2E failures in CI and release', () => {
        const document = parse(workflow) as {
            jobs: {
                e2e: {
                    steps: Array<{ name?: string; uses?: string; with?: Record<string, unknown> }>;
                };
            };
        };
        const releaseDocument = parse(releaseWorkflow) as {
            jobs: {
                release: {
                    steps: Array<{ name?: string; uses?: string; with?: Record<string, unknown> }>;
                };
            };
        };
        const uploads = [...document.jobs.e2e.steps, ...releaseDocument.jobs.release.steps].filter(
            (step) => step.name?.includes('failure artifacts'),
        );
        expect(uploads).toHaveLength(5);
        for (const upload of uploads) {
            expect(upload.uses).toMatch(/^actions\/upload-artifact@/u);
            expect(upload.with?.['retention-days']).toBe(7);
            const paths = String(upload.with?.path)
                .split('\n')
                .map((path) => path.trim())
                .filter(Boolean);
            expect(
                paths.some((path) => /^test-results\/receipts\/[\w*./-]+\.json$/u.test(path)),
            ).toBe(true);
            // A pool upload may add that pool's own Playwright output directory (screenshots, traces, and the
            // content-free log attachments, issue #1446); nothing else outside the bounded receipts is uploaded.
            expect(
                paths.every(
                    (path) =>
                        /^test-results\/receipts\/[\w*./-]+\.json$/u.test(path) ||
                        /^test-results\/(?:parallel-safe|desktop-exclusive|control)\/\*\*$/u.test(
                            path,
                        ),
                ),
            ).toBe(true);
        }
        expect(releaseWorkflow).toContain(
            'CAXRI_E2E_RECEIPT_PATH: test-results/receipts/release-packaged.json',
        );
        expect(releaseWorkflow).toContain(
            '--reporter=line,./scripts/reporters/e2e-receipt-reporter.ts',
        );
    });

    it('uploads a concurrent pool only once that pool actually started and left its receipt', () => {
        const document = parse(workflow) as {
            jobs: { e2e: { steps: Array<{ if?: string; name?: string }> } };
        };
        for (const pool of ['parallel-safe', 'desktop-exclusive']) {
            const upload = document.jobs.e2e.steps.find(
                (step) => step.name === `Upload ${pool} failure artifacts`,
            );
            const condition = String(upload?.if).replaceAll(/\s+/gu, ' ');
            // The direct pool step always launched the pool, so it uploads unconditionally on failure and keeps
            // `if-no-files-found: error` meaningful; the concurrent receipt check can fail for a pool that never ran.
            expect(condition).toContain(`steps.${pool}.outcome == 'failure' ||`);
            expect(condition).toContain(
                `steps.${pool}-receipt.outcome == 'failure' && hashFiles('test-results/receipts/${pool}.json') != ''`,
            );
        }
    });
});
