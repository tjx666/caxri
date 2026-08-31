import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { writeJsonAtomic } from './atomic-json';

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;

interface MobileAcceptanceCommand {
    arguments: string[];
    captureOutput?: boolean;
    command: string;
    cwd: string;
    deadlineMs: number;
    environment?: NodeJS.ProcessEnv;
    nowMs?: number;
    timeoutMs: number;
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Runs one Acceptance child with both a stage timeout and a shared overall deadline. The caller owns the deadline so
 * cleanup can reserve a final bounded window instead of inheriting an already exhausted build budget.
 */
export function runMobileAcceptanceCommand(
    input: MobileAcceptanceCommand,
    spawn: typeof spawnSync = spawnSync,
): string {
    const remainingMs = input.deadlineMs - (input.nowMs ?? Date.now());
    if (remainingMs <= 0) throw new Error('Mobile Acceptance exceeded its overall deadline');
    const timeout = Math.min(input.timeoutMs, remainingMs);
    const result = spawn(input.command, input.arguments, {
        cwd: input.cwd,
        encoding: input.captureOutput ? 'utf8' : undefined,
        env: input.environment ?? process.env,
        killSignal: 'SIGTERM',
        maxBuffer: input.captureOutput ? 4 * 1024 * 1024 : undefined,
        shell: false,
        stdio: input.captureOutput ? 'pipe' : 'inherit',
        timeout,
    });
    if (result.error) {
        if (errorCode(result.error) === 'ETIMEDOUT')
            throw new Error(`Mobile Acceptance command timed out after ${timeout}ms`);
        throw new Error('Mobile Acceptance command failed to start');
    }
    if (result.status !== 0)
        throw new Error(
            `Mobile Acceptance command failed with status ${result.status ?? 'unknown'}`,
        );
    return input.captureOutput && typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/**
 * Ensures evidence is built only from the clean source tree named by the frozen report.
 */
export function assertMobileAcceptanceSourceIdentity(input: {
    actualCommit: string;
    plannedCommit: string;
    status: string;
}): void {
    const actualCommit = input.actualCommit.trim().toLowerCase();
    const plannedCommit = input.plannedCommit.trim().toLowerCase();
    if (
        actualCommit !== plannedCommit ||
        !COMMIT_PATTERN.test(actualCommit) ||
        !COMMIT_PATTERN.test(plannedCommit)
    ) {
        throw new Error('Mobile Acceptance source does not match the frozen report commit');
    }
    if (input.status.trim().length > 0)
        throw new Error('Mobile Acceptance requires a clean source tree');
}

/**
 * Publishes the final receipt atomically so an authorized clean retry replaces only its predecessor.
 */
export function writeMobileAcceptanceReceipt(path: string, receipt: unknown): Promise<void> {
    return writeJsonAtomic(path, receipt);
}
