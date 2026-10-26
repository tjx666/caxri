import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { z } from 'zod';

import { writeTextAtomic } from '../../../../scripts/atomic-json';
import { sanitizeLedgerDetail } from './note-safety';
import type { GoState } from './state-model';

const MAX_EVENTS = 120;
const MAX_NOTES_PER_KIND = 20;
const MAX_ACCEPTANCE_HISTORY = 20;
const MAX_ORPHANED_ACCEPTANCE = 20;
const MAX_ROUTED_WORK = 50;
const MAX_SUPERSEDED_DRIFT_RECORDS = 20;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const ARCHIVE_PATH = /^artifacts\/ledger-history-([0-9a-f]{64})\.json$/u;

const archiveReceiptSchema = z.object({
    byteLength: z.number().int().positive(),
    counts: z.record(z.string(), z.number().int().positive()),
    entryCount: z.number().int().positive(),
    path: z.string().regex(ARCHIVE_PATH),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    updatedAt: z.string(),
});

export const ledgerRetentionSchema = z.object({ archive: archiveReceiptSchema.nullable() });
export type LedgerRetention = z.infer<typeof ledgerRetentionSchema>;

const archiveEntrySchema = z.object({
    archivedAt: z.string(),
    collection: z.string().min(1),
    value: z.unknown(),
});
const archiveSchema = z.object({
    entries: z.array(archiveEntrySchema),
    schemaVersion: z.literal(1),
});
type ArchiveEntry = z.infer<typeof archiveEntrySchema>;

export function createEmptyLedgerRetention(): LedgerRetention {
    return { archive: null };
}

function trimFront<T>(
    values: T[],
    limit: number,
    collection: string,
    archivedAt: string,
): ArchiveEntry[] {
    const excess = Math.max(0, values.length - limit);
    return values.splice(0, excess).map(
        (value) =>
            ({
                archivedAt,
                collection,
                value: sanitizeArchiveValue(value),
            }) satisfies ArchiveEntry,
    );
}

/**
 * Archived history is still persisted data, so it receives the same secret and size boundary.
 */
function sanitizeArchiveValue(value: unknown): unknown {
    if (typeof value === 'string') return sanitizeLedgerDetail(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeArchiveValue(item));
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, sanitizeArchiveValue(child)]),
        );
    }
    return value;
}

function archiveEntryFingerprint(entry: ArchiveEntry): string {
    return createHash('sha256')
        .update(JSON.stringify({ collection: entry.collection, value: entry.value }))
        .digest('hex');
}

function mergeArchiveEntries(previous: ArchiveEntry[], overflow: ArchiveEntry[]): ArchiveEntry[] {
    const existing = new Set(previous.map(archiveEntryFingerprint));
    return [
        ...previous,
        ...overflow.filter((entry) => {
            const fingerprint = archiveEntryFingerprint(entry);
            if (existing.has(fingerprint)) return false;
            existing.add(fingerprint);
            return true;
        }),
    ];
}

function collectOverflow(state: GoState, archivedAt: string): ArchiveEntry[] {
    const entries = trimFront(state.events, MAX_EVENTS, 'events', archivedAt);
    for (const kind of ['technical_debt', 'token_waste', 'workflow'] as const) {
        entries.push(
            ...trimFront(state.notes[kind], MAX_NOTES_PER_KIND, `notes.${kind}`, archivedAt),
        );
    }
    entries.push(
        ...trimFront(
            state.acceptance.publication.history,
            MAX_ACCEPTANCE_HISTORY,
            'acceptance.publication.history',
            archivedAt,
        ),
        ...trimFront(
            state.acceptance.publication.orphanedStandalones,
            MAX_ORPHANED_ACCEPTANCE,
            'acceptance.publication.orphanedStandalones',
            archivedAt,
        ),
        ...trimFront(
            state.runBudget.routedWork,
            MAX_ROUTED_WORK,
            'runBudget.routedWork',
            archivedAt,
        ),
    );
    for (const issue of state.issues) {
        const supersededIndexes = issue.expectationDrift.records
            .map((record, index) => ({ index, superseded: record.supersededBy !== null }))
            .filter(({ superseded }) => superseded)
            .map(({ index }) => index);
        const remove = new Set(
            supersededIndexes.slice(0, -MAX_SUPERSEDED_DRIFT_RECORDS || undefined),
        );
        if (remove.size === 0) continue;
        const retained: typeof issue.expectationDrift.records = [];
        for (const [index, record] of issue.expectationDrift.records.entries()) {
            if (remove.has(index)) {
                entries.push({
                    archivedAt,
                    collection: `issues.${issue.number}.expectationDrift.records`,
                    value: sanitizeArchiveValue(record),
                });
            } else retained.push(record);
        }
        issue.expectationDrift.records = retained;
    }
    return entries;
}

function countsFor(entries: ArchiveEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { collection } of entries) counts[collection] = (counts[collection] ?? 0) + 1;
    return counts;
}

async function ensureArtifactDirectory(
    runDirectory: string,
    expectedRunDirectory?: string,
): Promise<string> {
    const runMetadata = await lstat(runDirectory);
    if (runMetadata.isSymbolicLink() || !runMetadata.isDirectory()) {
        throw new Error('Go run directory must be a direct directory');
    }
    if (expectedRunDirectory && (await realpath(runDirectory)) !== expectedRunDirectory) {
        throw new Error('Go run directory changed during history retention');
    }
    const path = join(runDirectory, 'artifacts');
    try {
        await mkdir(path);
    } catch (error: unknown) {
        if (
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            error.code !== 'EEXIST'
        ) {
            throw error;
        }
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('Go history artifact directory must be a direct directory');
    }
    return path;
}

async function readArchive(
    runDirectory: string,
    retention: LedgerRetention,
    expectedRunDirectory?: string,
    shouldLoadEntries = true,
): Promise<ArchiveEntry[]> {
    const receipt = retention.archive;
    if (!receipt) return [];
    await ensureArtifactDirectory(runDirectory, expectedRunDirectory);
    const path = join(runDirectory, receipt.path);
    if (
        basename(path) !== basename(receipt.path) ||
        dirname(path) !== join(runDirectory, 'artifacts')
    ) {
        throw new Error('Go history artifact path is invalid');
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Go history artifact must be a direct regular file');
    }
    if (metadata.size > MAX_ARCHIVE_BYTES) {
        throw new Error(`Go history artifact exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    }
    if (metadata.size !== receipt.byteLength) {
        throw new Error('Go history artifact size does not match the ledger');
    }
    /**
     * Resume checks bounded metadata only; targeted audits and retention rewrites load content.
     */
    if (!shouldLoadEntries) return [];
    const source = await readFile(path, 'utf8');
    if (createHash('sha256').update(source).digest('hex') !== receipt.sha256) {
        throw new Error('Go history artifact checksum does not match the ledger');
    }
    const archive = archiveSchema.parse(JSON.parse(source));
    if (archive.entries.length !== receipt.entryCount) {
        throw new Error('Go history artifact count does not match the ledger');
    }
    const counts = countsFor(archive.entries);
    if (
        Object.keys(counts).length !== Object.keys(receipt.counts).length ||
        Object.entries(counts).some(([collection, count]) => receipt.counts[collection] !== count)
    ) {
        throw new Error('Go history artifact collection counts do not match the ledger');
    }
    return archive.entries;
}

async function writeArchive(
    runDirectory: string,
    entries: ArchiveEntry[],
    expectedRunDirectory?: string,
): Promise<string> {
    const artifacts = await ensureArtifactDirectory(runDirectory, expectedRunDirectory);
    const source = `${JSON.stringify({ entries, schemaVersion: 1 }, null, 2)}\n`;
    const digest = createHash('sha256').update(source).digest('hex');
    const destination = join(artifacts, `ledger-history-${digest}.json`);
    await writeTextAtomic(destination, source, {
        beforeRename: async () => {
            await ensureArtifactDirectory(runDirectory, expectedRunDirectory);
        },
        mode: 0o600,
    });
    return destination;
}

export async function applyLedgerRetention(
    path: string,
    state: GoState,
    expectedRunDirectory?: string,
): Promise<string | null> {
    const archivedAt = new Date().toISOString();
    const overflow = collectOverflow(state, archivedAt);
    if (overflow.length === 0) return null;
    const runDirectory = dirname(path);
    const previousPath = state.retention.archive?.path;
    const entries = mergeArchiveEntries(
        await readArchive(runDirectory, state.retention, expectedRunDirectory),
        overflow,
    );
    const destination = await writeArchive(runDirectory, entries, expectedRunDirectory);
    const archiveMetadata = await stat(destination);
    if (archiveMetadata.size > MAX_ARCHIVE_BYTES) {
        await rm(destination, { force: true });
        throw new Error(
            `Go history artifact exceeded ${MAX_ARCHIVE_BYTES} bytes; split the run before retrying`,
        );
    }
    const source = await readFile(destination, 'utf8');
    const sha256 = createHash('sha256').update(source).digest('hex');
    state.retention.archive = archiveReceiptSchema.parse({
        byteLength: archiveMetadata.size,
        counts: countsFor(entries),
        entryCount: entries.length,
        path: `artifacts/${basename(destination)}`,
        sha256,
        updatedAt: archivedAt,
    });
    return previousPath && previousPath !== state.retention.archive.path ? previousPath : null;
}

export async function verifyLedgerRetention(
    path: string,
    state: GoState,
    expectedRunDirectory?: string,
): Promise<void> {
    await readArchive(dirname(path), state.retention, expectedRunDirectory, false);
}
