#!/usr/bin/env bun

import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

import { loadAcceptanceCasePlan } from '../.agents/skills/acceptance/scripts/report';
import {
    assertMobileAcceptanceSourceIdentity,
    clearMobileAcceptanceCaseArtifacts,
    runMobileAcceptanceCommand,
    writeMobileAcceptanceReceipt,
} from './mobile-acceptance-runtime';

const CASE_ID = 'MOB-ACC-03';
const projectRoot = resolve(import.meta.dirname, '..');
const COMMAND_TIMEOUT_MS = 60_000;

/* eslint-disable unicorn/max-nested-calls -- Zod mirrors the nested LobeHub readback payload. */
const surfaceSchema = z.enum(['desktop', 'mobile']);
const planItemSchema = z.object({
    id: z.string().min(1),
    mobileDevice: z
        .object({
            appId: z.literal('com.caxri.mobile'),
            deviceId: z.string().min(1),
            platform: z.enum(['android', 'ios']),
        })
        .optional(),
    surface: surfaceSchema,
});
const reportSchema = z.object({
    commit: z.string().min(1),
    plan: z.array(planItemSchema).min(1),
});
const publicationRecordSchema = z.object({
    acceptanceId: z.string().min(1),
    checkIds: z.array(z.string().min(1)),
    headSha: z.string().min(1),
    roundIndex: z.number().int().positive(),
    verdict: z.enum(['fail', 'partial', 'pass', 'legacy-unavailable']),
    verifyRunId: z.string().min(1),
});
const stateSchema = z.object({
    acceptance: z.object({
        publication: z.object({ history: z.array(publicationRecordSchema) }),
    }),
});
const viewSchema = z.object({
    acceptance: z.object({ id: z.string().min(1) }),
    checks: z.array(
        z.object({
            id: z.string().min(1),
            planItem: z
                .object({ verifierConfig: z.object({ surface: surfaceSchema.optional() }) })
                .nullable()
                .optional(),
            resultRound: z.number().int().positive(),
            surface: surfaceSchema.nullable().optional(),
        }),
    ),
    rounds: z.array(
        z.object({
            report: z.object({ verdict: z.enum(['failed', 'passed', 'uncertain']) }),
            run: z.object({
                acceptanceId: z.string().min(1),
                context: z.object({ commit: z.string().min(1) }),
                id: z.string().min(1),
                roundIndex: z.number().int().positive(),
            }),
        }),
    ),
});
/* eslint-enable unicorn/max-nested-calls */

type PlanItem = z.infer<typeof planItemSchema>;
type PublicationRecord = z.infer<typeof publicationRecordSchema>;
type AcceptanceView = z.infer<typeof viewSchema>;

function sorted(values: string[]): string[] {
    return values.toSorted((left, right) => left.localeCompare(right));
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- focused tests exercise exact publication readback matching.
export function createMobileAcceptanceReadbackReceipt(input: {
    checkpointId: string;
    headSha: string;
    history: PublicationRecord[];
    plan: PlanItem[];
    view: AcceptanceView;
}) {
    const publication = input.history.find(({ verifyRunId }) => verifyRunId === input.checkpointId);
    if (!publication || publication.headSha !== input.headSha) {
        throw new Error('Acceptance publication checkpoint does not match the exact head');
    }
    const remoteRound = input.view.rounds.find(({ run }) => run.id === input.checkpointId);
    if (
        !remoteRound ||
        input.view.acceptance.id !== publication.acceptanceId ||
        remoteRound.run.acceptanceId !== publication.acceptanceId ||
        remoteRound.run.context.commit !== input.headSha ||
        remoteRound.run.roundIndex !== publication.roundIndex
    ) {
        throw new Error('Acceptance remote round does not match the immutable checkpoint');
    }
    const expectedVerdict = {
        'fail': 'failed',
        'legacy-unavailable': undefined,
        'partial': 'uncertain',
        'pass': 'passed',
    }[publication.verdict];
    if (!expectedVerdict || remoteRound.report.verdict !== expectedVerdict) {
        throw new Error('Acceptance remote verdict does not match publication history');
    }
    const remoteChecks = input.view.checks.filter(
        ({ resultRound }) => resultRound === publication.roundIndex,
    );
    const expectedIds = sorted(input.plan.map(({ id }) => id));
    const remoteIds = sorted(remoteChecks.map(({ id }) => id));
    if (
        JSON.stringify(expectedIds) !== JSON.stringify(sorted(publication.checkIds)) ||
        JSON.stringify(expectedIds) !== JSON.stringify(remoteIds)
    ) {
        throw new Error('Acceptance remote check ids do not match the frozen plan');
    }
    const planById = new Map(input.plan.map((item) => [item.id, item]));
    for (const check of remoteChecks) {
        const plan = planById.get(check.id);
        const surfaces = [check.surface, check.planItem?.verifierConfig.surface].filter(
            (surface): surface is 'desktop' | 'mobile' => Boolean(surface),
        );
        if (
            !plan ||
            surfaces.length === 0 ||
            surfaces.some((surface) => surface !== plan.surface)
        ) {
            throw new Error(`Acceptance remote surface does not match ${check.id}`);
        }
    }
    return {
        acceptanceId: publication.acceptanceId,
        caseId: CASE_ID,
        checkpointId: input.checkpointId,
        checkIds: expectedIds,
        exactHead: input.headSha,
        mobileDevices: input.plan.flatMap((item) =>
            item.mobileDevice ? [{ caseId: item.id, ...item.mobileDevice }] : [],
        ),
        outcome: 'publication-readback-verified',
        roundIndex: publication.roundIndex,
        schemaVersion: 1 as const,
        status: 'passed' as const,
        surfaces: [...new Set(input.plan.map(({ surface }) => surface))].toSorted((left, right) =>
            left.localeCompare(right),
        ),
        verdict: publication.verdict,
    };
}

async function main(): Promise<void> {
    const reportIndex = process.argv.indexOf('--report-dir');
    if (reportIndex === -1) throw new Error('--report-dir is required');
    const reportDirectory = process.argv[reportIndex + 1];
    if (!reportDirectory) throw new Error('--report-dir is required');
    const stateIndex = process.argv.indexOf('--state');
    if (stateIndex === -1) throw new Error('--state is required');
    const statePath = process.argv[stateIndex + 1];
    if (!statePath) throw new Error('--state is required');
    const stateFile = resolve(statePath);
    const stateMetadata = await lstat(stateFile);
    if (stateMetadata.isSymbolicLink() || !stateMetadata.isFile()) {
        throw new Error('Go state must be a direct regular file');
    }
    const planned = await loadAcceptanceCasePlan(reportDirectory, CASE_ID);
    if (
        planned.item.surface !== 'desktop' ||
        planned.item.stateIsolation.mode !== 'readonly_checkpoint'
    ) {
        throw new Error('Publication readback requires a desktop readonly checkpoint');
    }
    const checkpointId = planned.item.stateIsolation.checkpointId;
    const sourceCommit = runMobileAcceptanceCommand({
        arguments: ['rev-parse', 'HEAD'],
        captureOutput: true,
        command: 'git',
        cwd: projectRoot,
        deadlineMs: Date.now() + COMMAND_TIMEOUT_MS,
        timeoutMs: COMMAND_TIMEOUT_MS,
    })
        .trim()
        .toLowerCase();
    const sourceStatus = runMobileAcceptanceCommand({
        arguments: ['status', '--porcelain', '--untracked-files=normal'],
        captureOutput: true,
        command: 'git',
        cwd: projectRoot,
        deadlineMs: Date.now() + COMMAND_TIMEOUT_MS,
        timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertMobileAcceptanceSourceIdentity({
        actualCommit: sourceCommit,
        plannedCommit: planned.commit,
        status: sourceStatus,
    });
    await clearMobileAcceptanceCaseArtifacts(reportDirectory, CASE_ID);
    const [reportRaw, stateRaw] = await Promise.all([
        readFile(resolve(reportDirectory, 'result.json'), 'utf8'),
        readFile(stateFile, 'utf8'),
    ]);
    const report = reportSchema.parse(JSON.parse(reportRaw));
    const state = stateSchema.parse(JSON.parse(stateRaw));
    const publication = state.acceptance.publication.history.find(
        ({ verifyRunId }) => verifyRunId === checkpointId,
    );
    if (!publication) throw new Error('Go state has no matching verified publication checkpoint');
    const viewRaw = runMobileAcceptanceCommand({
        arguments: ['acceptance', 'view', publication.acceptanceId, '--json'],
        captureOutput: true,
        command: 'lobehub',
        cwd: projectRoot,
        deadlineMs: Date.now() + COMMAND_TIMEOUT_MS,
        timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const receipt = createMobileAcceptanceReadbackReceipt({
        checkpointId,
        headSha: sourceCommit,
        history: state.acceptance.publication.history,
        plan: report.plan,
        view: viewSchema.parse(JSON.parse(viewRaw)),
    });
    await writeMobileAcceptanceReceipt(
        resolve(reportDirectory, 'assets', `${CASE_ID}-readback.txt`),
        receipt,
    );
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
