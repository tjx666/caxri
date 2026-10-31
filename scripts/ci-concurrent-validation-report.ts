/**
 * Receipt shape and job-facing reporting for `scripts/ci-concurrent-validation.ts`: the failure summary, and the
 * `aborted` step output the Renderer performance gate keys on. Kept separate from the process orchestration so each
 * side stays under the source-size ratchet.
 */

import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const projectRoot = resolve(import.meta.dirname, '..');
export const receiptPath = resolve(
    projectRoot,
    'test-results',
    'receipts',
    'ci-concurrent-validation.json',
);

export interface ConcurrentValidationProvenance {
    checksRevision: string;
    exactHead: string;
    parallelWorkers: number;
    profile: 'optimized';
    runAttempt: string;
    runId: string;
}

export interface ConcurrentValidationReceipt {
    checks: number | null;
    desktopExclusive: number | null;
    e2eSetup: number | null;
    failureCensus: number | null;
    failureIsolation: number | null;
    manifest: number | null;
    parallelSafe: number | null;
    provenance: ConcurrentValidationProvenance;
    version: 1;
}

const RECEIPT_EXIT_KEYS = [
    'checks',
    'e2eSetup',
    'failureIsolation',
    'failureCensus',
    'parallelSafe',
    'desktopExclusive',
    'manifest',
] as const satisfies ReadonlyArray<keyof ConcurrentValidationReceipt>;

/**
 * Job-log search anchors for each receipted component. The concurrent `run` step inherits child stdio, so these strings
 * are the practical way to jump to the failing fragment without knowing the receipt file exists.
 */
function componentLogHint(label: string, preparationFailure?: string): string {
    const anchors = [`"${label} failed with exit"`, `"${label} could not start"`];
    if (preparationFailure) anchors.push(`"${preparationFailure}"`);
    return `Search the job log for ${anchors.join(' or ')}.`;
}

const RECEIPT_LOG_HINTS = {
    checks: componentLogHint('Full platform checks', 'Full platform checks could not prepare'),
    desktopExclusive: componentLogHint('Desktop-exclusive E2E pool'),
    e2eSetup: `${componentLogHint('Electron Vite build')} ${componentLogHint('Electron native compatibility')}`,
    failureCensus: componentLogHint('Bounded E2E failure census'),
    failureIsolation: componentLogHint('Desktop worker interruption recovery'),
    manifest: componentLogHint('E2E execution receipt'),
    parallelSafe: componentLogHint('Parallel-safe E2E pool'),
} as const satisfies Record<(typeof RECEIPT_EXIT_KEYS)[number], string>;

/**
 * Human-readable failure summary for a concurrent-validation receipt. Green receipts return `undefined` so a passing
 * `run` stays silent. Null (skipped) components are not listed; only a concrete non-zero exit is.
 */
export function formatConcurrentValidationFailureSummary(
    receipt: ConcurrentValidationReceipt,
    receiptFile = receiptPath,
): string | undefined {
    const failed = RECEIPT_EXIT_KEYS.flatMap((key) => {
        const exitCode = receipt[key];
        return typeof exitCode === 'number' && exitCode !== 0
            ? [`- ${key}: exit ${exitCode}. ${RECEIPT_LOG_HINTS[key]}`]
            : [];
    });
    if (failed.length === 0) return undefined;
    return ['Concurrent validation failed.', ...failed, `Receipt: ${receiptFile}`].join('\n');
}

export async function publishConcurrentValidationFailureSummary(
    receipt: ConcurrentValidationReceipt,
): Promise<void> {
    const summary = formatConcurrentValidationFailureSummary(receipt);
    if (!summary) return;
    console.error(summary);
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) await appendFile(stepSummary, `${summary}\n`);
}

/**
 * Publishes whether the run was aborted as the `aborted` step output. `execute()` exits zero even after an abort (the
 * verify steps own the failure), but a SIGTERM that lands mid Electron launch leaves a pending desktop lease handoff.
 * The Renderer performance gate then fails on `acquireDesktopLease` with an error unrelated to performance, so the
 * workflow gates it on `aborted == 'false'` and the step summary names the abort as the reason it was skipped. Issue
 * #1852.
 */
export async function publishConcurrentValidationOutcome(
    processes: { readonly abortReason: string | undefined },
    {
        output = process.env.GITHUB_OUTPUT,
        summary = process.env.GITHUB_STEP_SUMMARY,
    }: { output?: string; summary?: string } = {},
): Promise<void> {
    const reason = processes.abortReason?.replaceAll(/[\r\n]+/gu, ' ');
    if (output) await appendFile(output, `aborted=${reason === undefined ? 'false' : 'true'}\n`);
    if (reason !== undefined && summary) {
        await appendFile(
            summary,
            `Renderer performance gate skipped: concurrent validation aborted (${reason})\n`,
        );
    }
}
