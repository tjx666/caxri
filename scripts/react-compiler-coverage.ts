import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';

import { transformAsync } from '@babel/core';
import { reactCompilerPreset } from '@vitejs/plugin-react';

import { rendererReactCompilerOptions } from './react-compiler-options';

/**
 * One component or hook the compiler left uncompiled, keyed without a line number so edits elsewhere do not churn.
 */
export interface ReactCompilerBailout {
    /**
     * Repository-relative path of the source file.
     */
    file: string;
    /**
     * The compiler's own reason, such as `(BuildHIR::lowerStatement) Handle TryStatement without a catch clause`.
     */
    reason: string;
    /**
     * 1-based line of the skipped function, for the failure message only.
     */
    line: number;
}

interface CompilerLoggerEvent {
    kind: string;
    fnLoc?: { start?: { line?: number } } | null;
    reason?: string;
    detail?: { reason?: string; options?: { reason?: string } };
    data?: string;
}

const BAILOUT_EVENT_KINDS = new Set(['CompileError', 'CompileSkip', 'PipelineError']);

function readReason(event: CompilerLoggerEvent): string {
    return (
        event.detail?.reason ??
        event.detail?.options?.reason ??
        event.reason ??
        event.data ??
        event.kind
    ).trim();
}

/**
 * Compiles `source` with the same React Compiler options the Renderer build uses and returns every function the
 * compiler skipped. The build never reports these: a skipped component silently loses memoization.
 */
export async function collectReactCompilerBailouts(
    source: string,
    filePath: string,
    repoRoot: string,
): Promise<ReactCompilerBailout[]> {
    const file = relative(repoRoot, filePath);
    const bailouts: ReactCompilerBailout[] = [];
    const { preset } = reactCompilerPreset({
        ...rendererReactCompilerOptions,
        logger: {
            logEvent(_filename: string | null, event: CompilerLoggerEvent) {
                if (!BAILOUT_EVENT_KINDS.has(event.kind)) return;
                bailouts.push({
                    file,
                    reason: readReason(event),
                    line: event.fnLoc?.start?.line ?? 0,
                });
            },
        },
    });
    await transformAsync(source, {
        filename: filePath,
        babelrc: false,
        configFile: false,
        code: false,
        plugins: [['@babel/plugin-syntax-typescript', { isTSX: filePath.endsWith('.tsx') }]],
        presets: [preset],
    });
    return bailouts;
}

export async function collectReactCompilerBailoutsForFile(
    filePath: string,
    repoRoot: string,
): Promise<ReactCompilerBailout[]> {
    return collectReactCompilerBailouts(await readFile(filePath, 'utf8'), filePath, repoRoot);
}

/**
 * Groups bailouts as `file -> sorted reasons`, the shape of the known-bailout ledger.
 */
export function groupBailoutReasons(
    bailouts: readonly ReactCompilerBailout[],
): Record<string, string[]> {
    const grouped: Partial<Record<string, string[]>> = {};
    for (const { file, reason } of bailouts) {
        const reasons = grouped[file] ?? [];
        reasons.push(reason);
        grouped[file] = reasons;
    }
    const sorted: Record<string, string[]> = {};
    for (const [file, reasons] of Object.entries(grouped))
        if (reasons) sorted[file] = reasons.toSorted((left, right) => left.localeCompare(right));
    return sorted;
}

/**
 * Compares the observed bailouts with the ledger. `unexpected` lists bailouts the ledger does not allow; `stale` lists
 * ledger entries the compiler no longer reports, which must be deleted so the ledger only shrinks.
 */
export function diffBailoutLedger(
    observed: Record<string, readonly string[]>,
    ledger: Record<string, readonly string[]>,
): { unexpected: string[]; stale: string[] } {
    const unexpected: string[] = [];
    const stale: string[] = [];
    const files = new Set([...Object.keys(observed), ...Object.keys(ledger)]);
    for (const file of files) {
        const remaining = [...(ledger[file] ?? [])];
        const observedReasons = observed[file] ?? [];
        for (const reason of observedReasons) {
            const index = remaining.indexOf(reason);
            if (index === -1) unexpected.push(`${file}: ${reason}`);
            else remaining.splice(index, 1);
        }
        for (const reason of remaining) stale.push(`${file}: ${reason}`);
    }
    return { unexpected, stale };
}
