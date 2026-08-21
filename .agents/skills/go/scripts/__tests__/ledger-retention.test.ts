import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyLedgerRetention, verifyLedgerRetention } from '../ledger-retention';
import { addEvent, createInitialState } from '../state-model';

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

describe('Go ledger retention', () => {
    it('keeps the exact in-ledger limit and archives only the oldest overflow', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-ledger-boundary-'));
        const statePath = join(directory, 'state.json');
        const state = createInitialState({
            objective: 'Retain bounded history',
            runId: 'boundary',
        });
        try {
            for (let index = 0; index < 119; index += 1) addEvent(state, 'test', `event ${index}`);
            await expect(applyLedgerRetention(statePath, state)).resolves.toBeNull();
            expect(state.events).toHaveLength(120);

            addEvent(state, 'test', 'overflow');
            await expect(applyLedgerRetention(statePath, state)).resolves.toBeNull();
            expect(state.events).toHaveLength(120);
            expect(state.retention.archive).toMatchObject({
                counts: { events: 1 },
                entryCount: 1,
            });
            const archive = await readFile(join(directory, state.retention.archive!.path), 'utf8');
            expect(createHash('sha256').update(archive).digest('hex')).toBe(
                state.retention.archive!.sha256,
            );
            const parsed = JSON.parse(archive) as {
                entries: Array<{ collection: string; value: { detail: string; type: string } }>;
            };
            expect(parsed.entries[0]).toMatchObject({
                collection: 'events',
                value: { detail: 'Run ledger initialized', type: 'init' },
            });
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('accepts the archive byte ceiling and rejects a file one byte over it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-ledger-bytes-'));
        const artifactPath = join(directory, 'artifacts', `ledger-history-${'a'.repeat(64)}.json`);
        const statePath = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Bound archive bytes', runId: 'bytes' });
        try {
            await mkdir(join(directory, 'artifacts'));
            await writeFile(artifactPath, '');
            await truncate(artifactPath, MAX_ARCHIVE_BYTES);
            state.retention.archive = {
                byteLength: MAX_ARCHIVE_BYTES,
                counts: { events: 1 },
                entryCount: 1,
                path: `artifacts/ledger-history-${'a'.repeat(64)}.json`,
                sha256: 'b'.repeat(64),
                updatedAt: '2026-08-21T00:00:00.000Z',
            };

            await expect(verifyLedgerRetention(statePath, state)).resolves.toBeUndefined();
            await truncate(artifactPath, MAX_ARCHIVE_BYTES + 1);
            await expect(verifyLedgerRetention(statePath, state)).rejects.toThrow(
                `exceeds ${MAX_ARCHIVE_BYTES} bytes`,
            );
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('fails closed when a retained archive is corrupted before the next append', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-ledger-corrupt-'));
        const statePath = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Verify history', runId: 'corrupt' });
        try {
            for (let index = 0; index < 120; index += 1) addEvent(state, 'test', `event ${index}`);
            await applyLedgerRetention(statePath, state);
            const archivePath = join(directory, state.retention.archive!.path);
            const source = await readFile(archivePath, 'utf8');
            await writeFile(archivePath, source.replace('{', '['), 'utf8');
            addEvent(state, 'test', 'next overflow');

            await expect(applyLedgerRetention(statePath, state)).rejects.toThrow(
                'checksum does not match the ledger',
            );
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
