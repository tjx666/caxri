import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BLOCKED_REASONS = ['plan-evidence-gap', 'execution-failed-before-evidence'] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];

const LIFECYCLE_RECEIPT_SUFFIXES = [
    '-state-isolation.json',
    '-fixture-preflight.json',
    '-agent-fixture.json',
] as const;

export function isLifecycleReceipt(path: string): boolean {
    return LIFECYCLE_RECEIPT_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

export function validateBlockedReason(input: {
    caseId: string;
    evidencePaths: string[];
    observation: string;
    reason?: BlockedReason;
    status: 'pass' | 'fail' | 'blocked';
    surface: 'cli' | 'desktop' | 'mobile';
}): string | undefined {
    if (!input.reason) return;
    if (input.status !== 'blocked' || input.surface !== 'mobile') {
        throw new Error(
            `Case ${input.caseId} ${input.reason} is only valid for a blocked mobile case`,
        );
    }
    const diagnosticPrefix = `assets/${encodeURIComponent(input.caseId)}-`;
    const diagnostics = input.evidencePaths.filter(
        (path) =>
            path.startsWith(diagnosticPrefix) &&
            /^[A-Za-z0-9-]+\.txt$/.test(path.slice(diagnosticPrefix.length)),
    );
    if (input.reason === 'execution-failed-before-evidence' && diagnostics.length !== 1) {
        throw new Error(
            `Case ${input.caseId} execution-failed-before-evidence requires a sanitized diagnostic text file`,
        );
    }
    const deviceReceipt = `assets/${encodeURIComponent(input.caseId)}-mobile-device.json`;
    const resultReceipt = `assets/${encodeURIComponent(input.caseId)}-result.json`;
    const hasSupport = input.evidencePaths.some(
        (path) => !isLifecycleReceipt(path) && path !== deviceReceipt && path !== resultReceipt,
    );
    if (!hasSupport || input.observation.trim().length < 20) {
        throw new Error(
            `Case ${input.caseId} ${input.reason} needs a concrete observation and supporting evidence`,
        );
    }
    return input.reason === 'execution-failed-before-evidence' ? diagnostics[0] : undefined;
}

/**
 * Read only after the caller has checked the diagnostic's canonical path stays under assets.
 */
export async function validateFailureDiagnostic(
    directory: string,
    caseId: string,
    diagnostic: string,
): Promise<void> {
    const content = await readFile(join(directory, diagnostic), 'utf8');
    if (content.trim().length < 20 || content.length > 4096) {
        throw new Error(
            `Case ${caseId} failure diagnostic must be a bounded, concrete text summary`,
        );
    }
}
