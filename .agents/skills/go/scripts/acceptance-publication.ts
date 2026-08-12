import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
const MAX_CLI_OUTPUT_BYTES = 5 * 1024 * 1024;
const CLI_TIMEOUT_MS = 60_000;
const CLI_KILL_GRACE_MS = 2_000;
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

type CommandRunner = (command: string, args: string[]) => Promise<string>;

const localReportSchema = z.object({
    cases: z.array(z.object({ id: z.string().min(1) })).min(1),
    commit: z.string().min(1),
    createdAt: z.string().min(1),
    plan: z.array(z.object({ id: z.string().min(1) })).min(1),
    requirement: z.string().min(1),
    summary: z.object({ verdict: z.enum(['fail', 'partial', 'pass']) }),
});

const ingestResultSchema = z.object({
    acceptanceId: z.string().min(1),
    roundIndex: z.number().int().positive(),
    verifyRunId: z.string().min(1),
});

const acceptanceRunListSchema = z.array(
    z.object({
        acceptanceId: z.string().min(1),
        context: z.looseObject({ commit: z.string().min(1), testedAt: z.string().min(1) }),
        id: z.string().min(1),
        plan: z.array(z.object({ id: z.string().min(1) })),
        roundIndex: z.number().int().positive(),
        source: z.literal('agent-testing'),
    }),
);

const acceptanceViewSchema = z.object({
    acceptance: z.object({ id: z.string().min(1) }),
    checks: z.array(z.object({ id: z.string().min(1), resultRound: z.number().int().positive() })),
    rounds: z.array(
        z.object({
            report: z.object({ verdict: z.enum(['failed', 'passed', 'uncertain']) }),
            run: z.object({
                acceptanceId: z.string().min(1),
                context: z.looseObject({ commit: z.string().min(1) }),
                id: z.string().min(1),
                roundIndex: z.number().int().positive(),
            }),
        }),
    ),
});

export function createEmptyAcceptancePublication(): AcceptancePublication {
    return { history: [], orphanedStandalones: [], pendingAttempt: null };
}

function stableAcceptanceUrl(acceptanceId: string): string {
    return `${ACCEPTANCE_URL_ROOT}/${acceptanceId}`;
}

function sorted(values: string[]): string[] {
    return [...values].sort((a, b) => a.localeCompare(b));
}

function equalValues(left: string[], right: string[]): boolean {
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
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
    const candidates = acceptanceRunListSchema.parse(JSON.parse(raw)).filter(
        (run) =>
            run.context.commit === input.headSha &&
            run.context.testedAt === input.createdAt &&
            run.roundIndex === input.roundIndex &&
            (!input.acceptanceId || run.acceptanceId === input.acceptanceId) &&
            equalValues(
                run.plan.map(({ id }) => id),
                input.checkIds,
            ),
    );
    if (candidates.length > 1) {
        throw new Error('LobeHub run discovery returned ambiguous matching rounds');
    }
    const candidate = candidates[0];
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
    args: string[],
    timeoutMs = CLI_TIMEOUT_MS,
): Promise<string> {
    return new Promise((resolveCapture, rejectCapture) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let tooLarge = false;
        let timedOut = false;
        let settled = false;
        const finish = (error?: Error, output?: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) rejectCapture(error);
            else resolveCapture(output ?? '');
        };
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            const forceKill = setTimeout(() => child.kill('SIGKILL'), CLI_KILL_GRACE_MS);
            forceKill.unref();
            finish(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref();
        const append = (target: 'stderr' | 'stdout', chunk: Buffer): void => {
            const next = (target === 'stdout' ? stdout : stderr) + chunk.toString();
            if (Buffer.byteLength(next) > MAX_CLI_OUTPUT_BYTES) {
                tooLarge = true;
                child.kill('SIGTERM');
                return;
            }
            if (target === 'stdout') stdout = next;
            else stderr = next;
        };
        child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
        child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
        child.once('error', (error) => finish(error));
        child.once('close', (code) => {
            if (timedOut) return;
            if (tooLarge) {
                finish(new Error(`${command} output exceeded the bounded capture limit`));
            } else if (code === 0) finish(undefined, stdout.trim());
            else finish(new Error(`${command} exited ${String(code)}`));
        });
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
    if (!input.acceptanceId.trim() || !input.reason.trim()) {
        throw new Error('Orphaned Acceptance history requires an id and reason');
    }
    if (
        state.acceptance.publication.orphanedStandalones.some(
            ({ acceptanceId, verifyRunId }) =>
                acceptanceId === input.acceptanceId &&
                verifyRunId === (input.verifyRunId?.trim() || null),
        )
    ) {
        return;
    }
    state.acceptance.publication.orphanedStandalones.push(
        orphanedAcceptanceSchema.parse({
            acceptanceId: input.acceptanceId.trim(),
            reason: input.reason.trim(),
            recordedAt,
            url: stableAcceptanceUrl(input.acceptanceId.trim()),
            verifyRunId: input.verifyRunId?.trim() || null,
        }),
    );
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
    const report = localReportSchema.parse(
        JSON.parse(await readFile(join(reportDirectory, 'result.json'), 'utf8')),
    );
    if (report.commit !== input.headSha) {
        throw new Error('Acceptance report does not match the exact head');
    }
    const checkIds = report.cases.map(({ id }) => id);
    if (
        !equalValues(
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
            !equalValues(pending.checkIds, checkIds) ||
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
        const args = [
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
                const stdout = await runner('lobehub', args);
                if (!stdout.trim()) throw new Error('LobeHub ingest returned empty JSON output');
                ingest = ingestResultSchema.parse(JSON.parse(stdout));
            } catch (error: unknown) {
                const recovered = await discoverPublishedRun(runner, discoveryInput).catch(
                    () => null,
                );
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
    const remoteCheckIds = view.checks
        .filter(({ resultRound }) => resultRound === expectedRound)
        .map(({ id }) => id);
    if (!equalValues(remoteCheckIds, checkIds)) {
        throw new Error('LobeHub readback check ids do not match the local round');
    }
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
