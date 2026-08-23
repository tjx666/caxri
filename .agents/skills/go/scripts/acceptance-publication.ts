import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { captureCommand } from './command-runner';
import { PROJECT_ROOT, RECORDS_ROOT } from './paths';

const MAX_CLI_OUTPUT_BYTES = 5 * 1024 * 1024;
const CLI_TIMEOUT_MS = 60_000;
const ACCEPTANCE_INGEST_TIMEOUT_MS = 10 * 60_000;
const ACCEPTANCE_URL_ROOT = 'https://app.lobehub.com/acceptance';

const publishedVerdictSchema = z.enum(['fail', 'partial', 'pass', 'legacy-unavailable']);
const publicationRecordSchema = z.object({
    acceptanceId: z.string().min(1),
    checkIds: z.array(z.string().min(1)),
    headSha: z.string().min(1),
    publishedAt: z.string(),
    roundIndex: z.number().int().positive(),
    url: z.url(),
    verdict: publishedVerdictSchema,
    verifyRunId: z.string().min(1),
});
const orphanedAcceptanceSchema = z.object({
    acceptanceId: z.string().min(1),
    reason: z.string().min(1),
    recordedAt: z.string(),
    url: z.url(),
    verifyRunId: z.string().min(1).nullable(),
});
const pendingPublicationSchema = z.object({
    acceptanceId: z.string().min(1),
    checkIds: z.array(z.string().min(1)),
    createdAt: z.string(),
    headSha: z.string().min(1),
    reportPath: z.string().min(1),
    roundIndex: z.number().int().positive(),
    verdict: z.enum(['fail', 'partial', 'pass']),
    verifyRunId: z.string().min(1),
});

export const acceptancePublicationSchema = z.object({
    history: z.array(publicationRecordSchema),
    orphanedStandalones: z.array(orphanedAcceptanceSchema),
    pendingAttempt: pendingPublicationSchema.nullable(),
});

export type AcceptancePublication = z.infer<typeof acceptancePublicationSchema>;
export type PublicationRecord = z.infer<typeof publicationRecordSchema>;

interface PublicationState {
    acceptance: {
        id: string | null;
        publication: AcceptancePublication;
        round: number;
        status: string;
        url: string | null;
    };
    phase: string;
    pullRequest: { headSha: string | null };
}

type CommandRunner = (command: string, arguments_: string[], timeoutMs?: number) => Promise<string>;

const checkIdSchema = z.object({ id: z.string().min(1) });
const evidenceTypeSchema = z.enum([
    'dom_snapshot',
    'gif',
    'markdown',
    'screenshot',
    'text',
    'video',
]);
const evidenceReferenceSchema = z.union([z.string().min(1), z.object({ path: z.string().min(1) })]);
const localCaseSchema = checkIdSchema.extend({
    evidence: z.array(evidenceReferenceSchema).min(1),
});
const requiredEvidenceSchema = z.union([
    evidenceTypeSchema,
    z.object({ hint: z.string().optional(), type: evidenceTypeSchema }),
]);
const localPlanItemSchema = checkIdSchema.extend({
    requiredEvidence: z.array(requiredEvidenceSchema).min(1),
});

const localReportSchema = z.object({
    cases: z.array(localCaseSchema).min(1),
    commit: z.string().min(1),
    createdAt: z.string().min(1),
    plan: z.array(localPlanItemSchema).min(1),
    requirement: z.string().min(1),
    summary: z.object({ verdict: z.enum(['fail', 'partial', 'pass']) }),
});

const ingestResultSchema = z.object({
    acceptanceId: z.string().min(1),
    roundIndex: z.number().int().positive(),
    verifyRunId: z.string().min(1),
});

const acceptanceRunCandidateSchema = z.object({
    acceptanceId: z.string().min(1),
    context: z.looseObject({ commit: z.string().min(1), testedAt: z.string().min(1) }),
    id: z.string().min(1),
    plan: z.array(checkIdSchema),
    roundIndex: z.number().int().positive(),
    source: z.literal('agent-testing'),
});
const acceptanceRunListSchema = z.array(z.unknown());

const acceptanceRunSchema = z.object({
    acceptanceId: z.string().min(1),
    context: z.looseObject({ commit: z.string().min(1) }),
    id: z.string().min(1),
    roundIndex: z.number().int().positive(),
});
const acceptanceRoundSchema = z.object({
    report: z.object({ verdict: z.enum(['failed', 'passed', 'uncertain']) }),
    run: acceptanceRunSchema,
});
const acceptanceEvidenceSchema = z.object({
    content: z.string().min(1).nullable().optional(),
    fileId: z.string().min(1).nullable().optional(),
    fileUrl: z.string().min(1).nullable().optional(),
    type: evidenceTypeSchema,
});
const acceptanceCheckSchema = z.object({
    evidence: z.array(acceptanceEvidenceSchema),
    id: z.string().min(1),
    resultRound: z.number().int().positive(),
});
const acceptanceViewSchema = z.object({
    acceptance: z.object({ id: z.string().min(1) }),
    checks: z.array(acceptanceCheckSchema),
    rounds: z.array(acceptanceRoundSchema),
});

export function createEmptyAcceptancePublication(): AcceptancePublication {
    return { history: [], orphanedStandalones: [], pendingAttempt: null };
}

function stableAcceptanceUrl(acceptanceId: string): string {
    return `${ACCEPTANCE_URL_ROOT}/${acceptanceId}`;
}

function sorted(values: string[]): string[] {
    return values.toSorted((a, b) => a.localeCompare(b));
}

function haveEqualValues(left: string[], right: string[]): boolean {
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function evidenceTypeForPath(path: string): z.infer<typeof evidenceTypeSchema> {
    const extension = extname(path).toLowerCase();
    if (extension === '.gif') return 'gif';
    if (['.bmp', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(extension)) {
        return 'screenshot';
    }
    if (['.m4v', '.mov', '.mp4', '.webm'].includes(extension)) return 'video';
    if (['.html', '.htm'].includes(extension)) return 'dom_snapshot';
    if (['.markdown', '.md'].includes(extension)) return 'markdown';
    return 'text';
}

function evidencePath(reference: z.infer<typeof evidenceReferenceSchema>): string {
    return typeof reference === 'string' ? reference : reference.path;
}

function requiredEvidenceType(
    evidence: z.infer<typeof requiredEvidenceSchema>,
): z.infer<typeof evidenceTypeSchema> {
    return typeof evidence === 'string' ? evidence : evidence.type;
}

/**
 * For LobeHub publication, a successful command is insufficient: the remote evidence
 * inventory must match every local case exactly so
 * the reviewer receives every declared screenshot and recording.
 */
function assertRemoteEvidenceIntegrity(
    report: z.infer<typeof localReportSchema>,
    remoteChecks: Array<z.infer<typeof acceptanceCheckSchema>>,
): void {
    const planById = new Map(report.plan.map((item) => [item.id, item]));
    const remoteById = new Map(remoteChecks.map((check) => [check.id, check]));

    for (const acceptanceCase of report.cases) {
        const expectedTypes = acceptanceCase.evidence.map((reference) =>
            evidenceTypeForPath(evidencePath(reference)),
        );
        const requiredEvidence = planById.get(acceptanceCase.id)?.requiredEvidence ?? [];
        for (const requirement of requiredEvidence) {
            const type = requiredEvidenceType(requirement);
            if (!expectedTypes.includes(type)) {
                throw new Error(
                    `Acceptance local evidence for ${acceptanceCase.id} does not satisfy required ${type} evidence`,
                );
            }
        }

        const remote = remoteById.get(acceptanceCase.id);
        if (
            !remote ||
            !haveEqualValues(
                remote.evidence.map(({ type }) => type),
                expectedTypes,
            )
        ) {
            throw new Error(
                `LobeHub readback evidence does not match the local round for ${acceptanceCase.id}`,
            );
        }
        for (const evidence of remote.evidence) {
            const hasPayload = Boolean(evidence.content ?? evidence.fileUrl);
            const requiresFile = ['gif', 'screenshot', 'video'].includes(evidence.type);
            if (!hasPayload || (requiresFile && (!evidence.fileId || !evidence.fileUrl))) {
                throw new Error(
                    `LobeHub readback evidence payload is missing for ${acceptanceCase.id}`,
                );
            }
        }
    }
}

/**
 * Run history can contain legacy `agent` rows and interrupted rows with null lineage fields. They cannot prove that
 * this exact round already exists, so discovery ignores them while the matching candidate and subsequent Acceptance
 * readback remain strictly validated.
 */
function discoverableAcceptanceRuns(
    value: unknown,
): Array<z.infer<typeof acceptanceRunCandidateSchema>> {
    return acceptanceRunListSchema.parse(value).flatMap((run) => {
        const parsed = acceptanceRunCandidateSchema.safeParse(run);
        return parsed.success ? [parsed.data] : [];
    });
}

async function discoverPublishedRun(
    runner: CommandRunner,
    input: {
        acceptanceId: string | null;
        checkIds: string[];
        createdAt: string;
        headSha: string;
        roundIndex: number;
    },
): Promise<z.infer<typeof ingestResultSchema> | null> {
    const raw = await runner('lobehub', ['acceptance', 'run', 'list', '--json']);
    if (!raw.trim()) throw new Error('LobeHub run discovery returned empty JSON output');
    const candidates = discoverableAcceptanceRuns(JSON.parse(raw)).filter(
        (run) =>
            run.context.commit === input.headSha &&
            run.context.testedAt === input.createdAt &&
            run.roundIndex === input.roundIndex &&
            (!input.acceptanceId || run.acceptanceId === input.acceptanceId) &&
            haveEqualValues(
                run.plan.map(({ id }) => id),
                input.checkIds,
            ),
    );
    if (candidates.length > 1) {
        throw new Error('LobeHub run discovery returned ambiguous matching rounds');
    }
    // `.at()` (unlike index access) types the result as `T | undefined`, matching the real
    // possibility that no candidate matched (`candidates.length === 0`).
    const candidate = candidates.at(0);
    return candidate
        ? {
              acceptanceId: candidate.acceptanceId,
              roundIndex: candidate.roundIndex,
              verifyRunId: candidate.id,
          }
        : null;
}

export function commandCapture(
    command: string,
    arguments_: string[],
    timeoutMs = CLI_TIMEOUT_MS,
    killGraceMs?: number,
): Promise<string> {
    return captureCommand(command, arguments_, {
        killGraceMs,
        maxOutputBytes: MAX_CLI_OUTPUT_BYTES,
        timeoutMs,
    });
}

async function resolveReportDirectory(path: string): Promise<string> {
    const candidate = resolve(PROJECT_ROOT, path);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Acceptance round must be a direct directory');
    }
    const [recordsRoot, directory] = await Promise.all([
        realpath(RECORDS_ROOT),
        realpath(candidate),
    ]);
    const relativePath = relative(recordsRoot, directory);
    if (
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    ) {
        throw new Error('Acceptance round must stay under .records/');
    }
    if (!/^round-[1-9]\d*$/u.test(basename(directory))) {
        throw new Error('Acceptance round directory must end with round-<positive integer>');
    }
    const resultPath = join(directory, 'result.json');
    const resultMetadata = await lstat(resultPath);
    if (resultMetadata.isSymbolicLink() || !resultMetadata.isFile()) {
        throw new Error('Acceptance result.json must be a direct regular file');
    }
    return directory;
}

export function recordPublishedAcceptance(
    state: PublicationState,
    record: PublicationRecord,
): PublicationRecord {
    if (state.acceptance.id && state.acceptance.id !== record.acceptanceId) {
        throw new Error('Published Acceptance id does not match the frozen lineage');
    }
    if (state.acceptance.url && state.acceptance.url !== record.url) {
        throw new Error('Published Acceptance URL does not match the frozen lineage');
    }
    if (record.roundIndex !== state.acceptance.round + 1) {
        throw new Error('Published Acceptance round is not the next lineage round');
    }
    state.acceptance.id = record.acceptanceId;
    state.acceptance.url = record.url;
    state.acceptance.round = record.roundIndex;
    state.acceptance.status = 'pending';
    state.acceptance.publication.history.push(record);
    return record;
}

export function assertPublishedAcceptanceLineage(
    state: PublicationState,
    expectedHeadSha?: string,
): void {
    const latest = state.acceptance.publication.history.at(-1);
    if (!latest) throw new Error('Acceptance has no verified publication lineage');
    if (
        latest.acceptanceId !== state.acceptance.id ||
        latest.url !== state.acceptance.url ||
        latest.roundIndex !== state.acceptance.round
    ) {
        throw new Error('Acceptance publication lineage does not match the ledger summary');
    }
    if (
        expectedHeadSha &&
        latest.verifyRunId !== 'legacy-unavailable' &&
        latest.headSha !== expectedHeadSha
    ) {
        throw new Error('Acceptance publication lineage does not match the exact PR head');
    }
}

export function recordOrphanedAcceptance(
    state: PublicationState,
    input: { acceptanceId: string; reason: string; verifyRunId?: string },
    recordedAt = new Date().toISOString(),
): void {
    const acceptanceId = input.acceptanceId.trim();
    const reason = input.reason.trim();
    if (!acceptanceId || !reason) {
        throw new Error('Orphaned Acceptance history requires an id and reason');
    }
    // Intentional `||`: an empty (whitespace-only) trimmed value must also collapse to `null`,
    // not be kept as `''`.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- see comment above
    const verifyRunId = input.verifyRunId?.trim() || null;
    const isAlreadyRecorded = state.acceptance.publication.orphanedStandalones.some(
        (record) => record.acceptanceId === acceptanceId && record.verifyRunId === verifyRunId,
    );
    if (!isAlreadyRecorded) {
        state.acceptance.publication.orphanedStandalones.push(
            orphanedAcceptanceSchema.parse({
                acceptanceId,
                reason,
                recordedAt,
                url: stableAcceptanceUrl(acceptanceId),
                verifyRunId,
            }),
        );
    }

    const pending = state.acceptance.publication.pendingAttempt;
    /**
     * Only the explicit, immutable orphan record for the exact remote run permits a fresh upload.
     */
    if (
        verifyRunId !== null &&
        pending?.acceptanceId === acceptanceId &&
        pending.verifyRunId === verifyRunId
    ) {
        state.acceptance.publication.pendingAttempt = null;
    }
}

export async function publishAcceptanceRound(
    state: PublicationState,
    input: { headSha: string; reportDirectory: string },
    runner: CommandRunner = commandCapture,
    publishedAt = new Date().toISOString(),
    persistPending: () => Promise<void> = () => Promise.resolve(),
): Promise<PublicationRecord> {
    if (state.phase !== 'acceptance') {
        throw new Error('Acceptance rounds can be published only during the Acceptance phase');
    }
    if (!state.pullRequest.headSha || state.pullRequest.headSha !== input.headSha) {
        throw new Error('Acceptance publication must bind the exact current PR head');
    }
    const reportDirectory = await resolveReportDirectory(input.reportDirectory);
    const reportSource = await readFile(join(reportDirectory, 'result.json'), 'utf8');
    const report = localReportSchema.parse(JSON.parse(reportSource));
    if (report.commit !== input.headSha) {
        throw new Error('Acceptance report does not match the exact head');
    }
    const checkIds = report.cases.map(({ id }) => id);
    if (
        !haveEqualValues(
            checkIds,
            report.plan.map(({ id }) => id),
        )
    ) {
        throw new Error('Acceptance report cases do not match the frozen plan');
    }
    const expectedRound = state.acceptance.round + 1;
    const directoryRound = Number(/^round-(\d+)$/u.exec(basename(reportDirectory))?.[1]);
    if (directoryRound !== expectedRound) {
        throw new Error('Acceptance report directory is not the next lineage round');
    }

    const reportPath = relative(PROJECT_ROOT, reportDirectory);
    const pending = state.acceptance.publication.pendingAttempt;
    let ingest: z.infer<typeof ingestResultSchema>;
    if (pending) {
        if (
            pending.headSha !== input.headSha ||
            pending.reportPath !== reportPath ||
            pending.roundIndex !== expectedRound ||
            pending.verdict !== report.summary.verdict ||
            !haveEqualValues(pending.checkIds, checkIds) ||
            (state.acceptance.id && pending.acceptanceId !== state.acceptance.id)
        ) {
            throw new Error('Pending Acceptance publication does not match this local round');
        }
        ingest = ingestResultSchema.parse(pending);
    } else {
        const discoveryInput = {
            acceptanceId: state.acceptance.id,
            checkIds,
            createdAt: report.createdAt,
            headSha: input.headSha,
            roundIndex: expectedRound,
        };
        const existing = await discoverPublishedRun(runner, discoveryInput);
        const arguments_ = [
            'acceptance',
            'run',
            'ingest',
            reportDirectory,
            '--source',
            'agent-testing',
            ...(state.acceptance.id
                ? ['--acceptance', state.acceptance.id]
                : ['--requirement', report.requirement]),
            '--json',
        ];
        if (existing) {
            ingest = existing;
        } else {
            try {
                const stdout = await runner('lobehub', arguments_, ACCEPTANCE_INGEST_TIMEOUT_MS);
                if (!stdout.trim()) throw new Error('LobeHub ingest returned empty JSON output');
                ingest = ingestResultSchema.parse(JSON.parse(stdout));
            } catch (error: unknown) {
                let recovered: z.infer<typeof ingestResultSchema> | null;
                try {
                    recovered = await discoverPublishedRun(runner, discoveryInput);
                } catch {
                    recovered = null;
                }
                if (!recovered) throw error;
                ingest = recovered;
            }
        }
        if (state.acceptance.id && ingest.acceptanceId !== state.acceptance.id) {
            throw new Error('LobeHub ingest returned a different Acceptance id');
        }
        if (ingest.roundIndex !== expectedRound) {
            throw new Error('LobeHub ingest returned an unexpected round index');
        }
        state.acceptance.publication.pendingAttempt = pendingPublicationSchema.parse({
            ...ingest,
            checkIds: sorted(checkIds),
            createdAt: publishedAt,
            headSha: input.headSha,
            reportPath,
            verdict: report.summary.verdict,
        });
        await persistPending();
    }

    const viewRaw = await runner('lobehub', ['acceptance', 'view', ingest.acceptanceId, '--json']);
    if (!viewRaw.trim()) throw new Error('LobeHub Acceptance readback returned empty JSON output');
    const view = acceptanceViewSchema.parse(JSON.parse(viewRaw));
    const remoteRound = view.rounds.find(({ run }) => run.id === ingest.verifyRunId);
    if (!remoteRound) throw new Error('LobeHub readback is missing the ingested round');
    if (
        view.acceptance.id !== ingest.acceptanceId ||
        remoteRound.run.acceptanceId !== ingest.acceptanceId
    ) {
        throw new Error('LobeHub readback returned a different Acceptance lineage');
    }
    if (remoteRound.run.roundIndex !== expectedRound) {
        throw new Error('LobeHub readback returned an unexpected round index');
    }
    if (remoteRound.run.context.commit !== input.headSha) {
        throw new Error('LobeHub readback does not match the exact head');
    }
    const remoteChecks = view.checks.filter(({ resultRound }) => resultRound === expectedRound);
    const remoteCheckIds = remoteChecks.map(({ id }) => id);
    if (!haveEqualValues(remoteCheckIds, checkIds)) {
        throw new Error('LobeHub readback check ids do not match the local round');
    }
    assertRemoteEvidenceIntegrity(report, remoteChecks);
    const expectedVerdict = { fail: 'failed', partial: 'uncertain', pass: 'passed' }[
        report.summary.verdict
    ];
    if (remoteRound.report.verdict !== expectedVerdict) {
        throw new Error('LobeHub readback verdict does not match the local report');
    }

    state.acceptance.publication.pendingAttempt = null;
    return recordPublishedAcceptance(
        state,
        publicationRecordSchema.parse({
            acceptanceId: ingest.acceptanceId,
            checkIds: sorted(checkIds),
            headSha: input.headSha,
            publishedAt,
            roundIndex: ingest.roundIndex,
            url: stableAcceptanceUrl(ingest.acceptanceId),
            verdict: report.summary.verdict,
            verifyRunId: ingest.verifyRunId,
        }),
    );
}
