#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from '../.agents/skills/acceptance/scripts/case-lifecycle';
import { loadAcceptanceCasePlan } from '../.agents/skills/acceptance/scripts/report';
import {
    assertMobileAcceptanceSourceIdentity,
    clearMobileAcceptanceCaseArtifacts,
    runMobileAcceptanceCommand,
} from './mobile-acceptance-runtime';

const projectRoot = resolve(import.meta.dirname, '..');
const SOURCE_TIMEOUT_MS = 10_000;
const PROGRAM_TIMEOUT_MS = 5 * 60_000;

interface ProgramCaseDefinition {
    scenarios: string[];
    testFiles: string[];
}

const programCases = {
    'MOB-ACC-01': {
        scenarios: [
            'cross-surface-evidence-rejected',
            'wrong-device-rejected',
            'wrong-source-commit-rejected',
            'wrong-lifecycle-binding-rejected',
            'wrong-media-hash-rejected',
        ],
        testFiles: [
            '.agents/skills/acceptance/scripts/report-mobile.test.ts',
            '.agents/skills/acceptance/scripts/media-integrity.test.ts',
        ],
    },
    'MOB-SEC-01': {
        scenarios: [
            'successful-encrypted-handshake',
            'tampered-frame-rejected',
            'replayed-frame-rejected',
            'out-of-order-frame-rejected',
            'cross-connection-frame-rejected',
            'invalid-pairing-secret-rejected',
            'expired-pairing-secret-rejected',
            'oversized-frame-rejected',
            'method-allowlist-enforced',
            'project-scope-enforced',
        ],
        testFiles: [
            'packages/mobile-transport/src/__tests__/sealed-frame.test.ts',
            'packages/mobile-transport/src/__tests__/session-keys.test.ts',
            'apps/server/src/core/mobile/__tests__/gateway.test.ts',
            'apps/server/src/core/mobile/__tests__/access-controller.test.ts',
            'apps/server/src/core/mobile/__tests__/device-registry.test.ts',
        ],
    },
    'MOB-SEC-02': {
        scenarios: ['active-connection-revoked', 'old-generation-rejected'],
        testFiles: [
            'apps/server/src/core/mobile/__tests__/gateway.test.ts',
            'apps/server/src/core/mobile/__tests__/access-controller.test.ts',
            'apps/server/src/core/mobile/__tests__/device-registry.test.ts',
        ],
    },
    'MOB-SEC-03': {
        scenarios: [
            'loopback-control-preserved',
            'origin-policy-preserved',
            'desktop-welcome-preserved',
            'desktop-command-boundary-preserved',
        ],
        testFiles: [
            'apps/server/src/core/__tests__/control-server.test.ts',
            'apps/server/src/core/__tests__/server-core.integration.test.ts',
        ],
    },
    'MOB-SESSION-04': {
        scenarios: [
            'project-scope-read-rejected',
            'shell-reply-rejected',
            'non-waiting-reply-rejected',
            'non-primary-agent-reply-rejected',
            'oversized-reply-rejected',
            'control-character-reply-rejected',
            'enter-false-rejected',
            'stale-attention-rejected',
            'revoked-device-rejected',
        ],
        testFiles: [
            'apps/server/src/core/mobile/__tests__/access-controller.test.ts',
            'apps/server/src/core/mobile/__tests__/gateway-reply.test.ts',
            'apps/server/src/domains/agent-dispatch/__tests__/integration.test.ts',
        ],
    },
} satisfies Record<string, ProgramCaseDefinition>;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise the guarded case router.
export type MobileAcceptanceProgramCaseId = keyof typeof programCases;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise the guarded argument contract.
export interface MobileAcceptanceProgramArguments {
    caseId: MobileAcceptanceProgramCaseId;
    reportDirectory: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise the guarded case router.
export function mobileAcceptanceProgramCase(caseId: string): ProgramCaseDefinition {
    if (!Object.hasOwn(programCases, caseId)) {
        throw new Error(`Unsupported program Acceptance case: ${caseId}`);
    }
    return programCases[caseId as MobileAcceptanceProgramCaseId];
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise the guarded argument contract.
export function parseMobileAcceptanceProgramArguments(
    values: readonly string[],
): MobileAcceptanceProgramArguments {
    const reportIndex = values.indexOf('--report-dir');
    const reportDirectory = values[reportIndex + 1];
    if (reportIndex === -1 || !reportDirectory) throw new Error('--report-dir is required');
    const caseIndex = values.indexOf('--case-id');
    const caseId = values[caseIndex + 1];
    if (caseIndex === -1 || !caseId) throw new Error('--case-id is required');
    mobileAcceptanceProgramCase(caseId);
    return {
        caseId: caseId as MobileAcceptanceProgramCaseId,
        reportDirectory: resolve(reportDirectory),
    };
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise the content-free receipt contract.
export function createMobileAcceptanceProgramReceipt(input: {
    caseId: MobileAcceptanceProgramCaseId;
    completedAt: string;
    durationMs: number;
    sourceCommit: string;
    startedAt: string;
}) {
    return {
        caseId: input.caseId,
        completedAt: input.completedAt,
        durationMs: input.durationMs,
        result: 'passed' as const,
        scenarios: mobileAcceptanceProgramCase(input.caseId).scenarios,
        schemaVersion: 1 as const,
        sourceCommit: input.sourceCommit,
        startedAt: input.startedAt,
    };
}

async function main(): Promise<void> {
    const input = parseMobileAcceptanceProgramArguments(process.argv.slice(2));
    const planned = await loadAcceptanceCasePlan(input.reportDirectory, input.caseId);
    if (planned.item.surface !== 'desktop' || planned.item.stateIsolation.mode !== 'isolated') {
        throw new Error('Program Acceptance cases require an isolated desktop plan item');
    }
    const sourceCommit = runMobileAcceptanceCommand({
        arguments: ['rev-parse', 'HEAD'],
        captureOutput: true,
        command: 'git',
        cwd: projectRoot,
        deadlineMs: Date.now() + SOURCE_TIMEOUT_MS,
        timeoutMs: SOURCE_TIMEOUT_MS,
    });
    const sourceStatus = runMobileAcceptanceCommand({
        arguments: ['status', '--porcelain', '--untracked-files=normal'],
        captureOutput: true,
        command: 'git',
        cwd: projectRoot,
        deadlineMs: Date.now() + SOURCE_TIMEOUT_MS,
        timeoutMs: SOURCE_TIMEOUT_MS,
    });
    assertMobileAcceptanceSourceIdentity({
        actualCommit: sourceCommit,
        plannedCommit: planned.commit,
        status: sourceStatus,
    });

    await clearMobileAcceptanceCaseArtifacts(input.reportDirectory, input.caseId);
    const profileIdentity = `program-fixture:${input.caseId}:${randomUUID()}`;
    const launchId = await beginCaseLifecycle(input.reportDirectory, {
        caseId: input.caseId,
        profileIdentity,
        stateIsolation: planned.item.stateIsolation,
    });
    let failure: unknown;
    const startedAt = new Date();
    try {
        await markCaseLifecycleReady(input.reportDirectory, { caseId: input.caseId, launchId });
        const definition = mobileAcceptanceProgramCase(input.caseId);
        runMobileAcceptanceCommand({
            arguments: ['vitest', 'run', '--root', projectRoot, ...definition.testFiles],
            command: 'bunx',
            cwd: projectRoot,
            deadlineMs: Date.now() + PROGRAM_TIMEOUT_MS,
            timeoutMs: PROGRAM_TIMEOUT_MS,
        });
        const completedAt = new Date();
        const receipt = createMobileAcceptanceProgramReceipt({
            caseId: input.caseId,
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - startedAt.getTime(),
            sourceCommit: sourceCommit.trim().toLowerCase(),
            startedAt: startedAt.toISOString(),
        });
        await writeFile(
            join(input.reportDirectory, 'assets', `${input.caseId}-program.txt`),
            `${JSON.stringify(receipt, null, 2)}\n`,
            'utf8',
        );
    } catch (error) {
        failure = error;
    } finally {
        try {
            await completeCaseLifecycle(input.reportDirectory, {
                caseId: input.caseId,
                cleanupCompleted: true,
                cleanupRequested: true,
                launchId,
            });
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure) throw failure instanceof Error ? failure : new Error('Program Acceptance failed');
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
