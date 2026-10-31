import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
);

interface WorkflowStep {
    id?: string;
    if?: string;
    name?: string;
    uses?: string;
    with?: Record<string, unknown>;
}

function expectUploadsAfterPreparation(steps: WorkflowStep[], uploads: WorkflowStep[]): void {
    const prepareIndex = steps.findIndex((step) => step.id === 'prepare-public-e2e-receipts');
    const applicableUploads = uploads.filter((upload) => steps.includes(upload));
    expect(prepareIndex).toBeGreaterThanOrEqual(0);
    for (const upload of applicableUploads) {
        expect(steps.indexOf(upload)).toBeGreaterThan(prepareIndex);
    }
}

/**
 * E2E failure evidence is published as GitHub Actions artifacts, so the upload set stays bounded to content-safe JSON
 * receipts. Raw Playwright output can contain repository source, DOM snapshots, and Terminal content (issue #2118).
 */
describe('CI E2E artifacts', () => {
    it('uploads only bounded receipts from the E2E jobs in CI and release', () => {
        const document = parse(workflow) as {
            jobs: {
                e2e: {
                    steps: WorkflowStep[];
                };
            };
        };
        const releaseDocument = parse(releaseWorkflow) as {
            jobs: {
                release: {
                    steps: WorkflowStep[];
                };
            };
        };
        const ciUploads = document.jobs.e2e.steps.filter((step) =>
            step.uses?.startsWith('actions/upload-artifact@'),
        );
        const releaseFailureUploads = releaseDocument.jobs.release.steps.filter((step) =>
            step.uses?.startsWith('actions/upload-artifact@'),
        );
        const uploads = [...ciUploads, ...releaseFailureUploads];
        const expectedPaths = new Map([
            [
                'Upload Renderer performance receipt',
                'test-results/public-receipts/renderer-performance.json',
            ],
            [
                'Upload Agent Chat switch performance receipt',
                'test-results/public-receipts/agent-chat-session-switch.json',
            ],
            [
                'Upload parallel-safe failure artifacts',
                'test-results/public-receipts/parallel-safe.json',
            ],
            [
                'Upload desktop-exclusive failure artifacts',
                'test-results/public-receipts/desktop-exclusive.json',
            ],
            ['Upload control failure artifacts', 'test-results/public-receipts/control.json'],
            [
                'Upload packaged verification failure artifacts',
                'test-results/public-receipts/release-packaged.json',
            ],
        ]);
        const expectedConditions = new Map([
            [
                'Upload Renderer performance receipt',
                "always() && steps.prepare-public-e2e-receipts.outcome == 'success' && steps.renderer-performance.outcome != 'skipped'",
            ],
            [
                'Upload Agent Chat switch performance receipt',
                "always() && steps.prepare-public-e2e-receipts.outcome == 'success' && steps.agent-chat-switch-performance.outcome != 'skipped'",
            ],
            [
                'Upload parallel-safe failure artifacts',
                "always() && steps.prepare-public-e2e-receipts.outcome == 'success' && ( steps.parallel-safe.outcome == 'failure' || ( steps.parallel-safe-receipt.outcome == 'failure' && hashFiles('test-results/receipts/parallel-safe.json') != '' ) )",
            ],
            [
                'Upload desktop-exclusive failure artifacts',
                "always() && steps.prepare-public-e2e-receipts.outcome == 'success' && ( steps.desktop-exclusive.outcome == 'failure' || ( steps.desktop-exclusive-receipt.outcome == 'failure' && hashFiles('test-results/receipts/desktop-exclusive.json') != '' ) )",
            ],
            [
                'Upload control failure artifacts',
                "always() && steps.prepare-public-e2e-receipts.outcome == 'success' && steps.control.outcome == 'failure'",
            ],
            [
                'Upload packaged verification failure artifacts',
                "always() && steps.prepare-public-e2e-receipts.outcome == 'success' && steps.verify-packaged.outcome == 'failure'",
            ],
        ]);
        expect(ciUploads).toHaveLength(5);
        expect(releaseFailureUploads).toHaveLength(1);
        expect(uploads).toHaveLength(expectedPaths.size);
        for (const upload of uploads) {
            expect(upload.uses).toMatch(/^actions\/upload-artifact@/u);
            expect(upload.with?.['retention-days']).toBe(7);
            expect(upload.with?.path).toBe(expectedPaths.get(String(upload.name)));
            expect(String(upload.if).replaceAll(/\s+/gu, ' ')).toBe(
                expectedConditions.get(String(upload.name)),
            );
            expect(String(upload.with?.path)).not.toMatch(/[\n*{}]/u);
        }
        expect(new Set(uploads.map((upload) => upload.name))).toEqual(
            new Set(expectedPaths.keys()),
        );

        for (const steps of [document.jobs.e2e.steps, releaseDocument.jobs.release.steps]) {
            expectUploadsAfterPreparation(steps, uploads);
        }

        for (const forbidden of ['.zip', '.png', '.md', '.jsonl', '.log', '/**']) {
            expect(uploads.map((upload) => upload.with?.path).join('\n')).not.toContain(forbidden);
        }
        expect(workflow).not.toContain('scripts/redact-e2e-artifacts.ts');
        expect(releaseWorkflow).toContain(
            'CAXRI_E2E_RECEIPT_PATH: test-results/receipts/release-packaged.json',
        );
        expect(releaseWorkflow).toContain(
            '--reporter=./scripts/reporters/public-e2e-reporter.ts,./scripts/reporters/e2e-receipt-reporter.ts',
        );
        expect(releaseWorkflow).not.toContain('--reporter=line');
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
