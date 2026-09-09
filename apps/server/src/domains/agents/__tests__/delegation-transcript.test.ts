import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { MAX_AGENT_TRANSCRIPT_BYTES, readDelegationTranscript } from '../transcript';

async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'caxri-delegation-transcript-'));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const id = '019e676d-8740-7bb2-8bcb-f189c8260607';
    const date = new Date(0x019e676d8740);
    const day = [
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
    ];
    const directory = join(home, '.codex', 'sessions', ...day);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-${day.join('-')}T11-14-52-${id}.jsonl`);
    const database = {
        getTerminal: () => ({ provider: 'codex', agentSessionId: id, cwd: home }),
    } as unknown as CaxriDatabase;
    const read = (offset?: number, sessionId = id, turnId?: string) =>
        readDelegationTranscript(
            database,
            'terminal',
            sessionId,
            offset,
            {
                homeDirectory: home,
                variables: {},
            },
            turnId,
        );
    return { home, path, read, id };
}

describe('incremental delegation transcript evidence', () => {
    it('reads exact persisted turn finality even when its result file is missing', async () => {
        const f = await fixture();
        const native = new Database(join(f.home, '.codex', 'thread_history_1.sqlite'));
        try {
            native.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT)');
            const insert = native.prepare('INSERT INTO thread_turns VALUES (?, ?, ?)');
            insert.run(f.id, 'finished', 'completed');
            insert.run(f.id, 'running', 'inProgress');
            insert.run('foreign', 'other', 'completed');
            expect(await f.read(undefined, f.id, 'finished')).toEqual({
                content: '',
                isFinished: true,
            });
            expect(await f.read(undefined, f.id, 'running')).toEqual({
                content: '',
                isFinished: false,
            });
            expect(await f.read(undefined, f.id, 'other')).toEqual({
                content: '',
                isFinished: false,
            });
        } finally {
            native.close();
        }
    });
    it('includes a fast answer already persisted before the first read, then consumes only appended complete lines', async () => {
        const f = await fixture();
        const first = '{"synthetic":"first"}\n';
        await writeFile(f.path, first);
        expect(await f.read()).toEqual({ content: first, offset: first.length });
        expect(await f.read(first.length)).toEqual({ content: '', offset: first.length });
        await appendFile(f.path, '{"synthetic":');
        expect(await f.read(first.length)).toEqual({
            content: '',
            offset: first.length,
            failure: undefined,
        });
        await appendFile(f.path, '"second"}\n');
        expect(await f.read(first.length)).toEqual({
            content: '{"synthetic":"second"}\n',
            offset: first.length + '{"synthetic":"second"}\n'.length,
        });
    });
    it('bounds an initial long history while retaining the latest complete event', async () => {
        const f = await fixture();
        const tail = '{"synthetic":"final"}\n';
        const history = `${'x'.repeat(MAX_AGENT_TRANSCRIPT_BYTES + 1024)}\n`;
        await writeFile(f.path, history + tail);
        expect(await f.read()).toEqual({ content: tail, offset: history.length + tail.length });
    });
    it('fails closed for a stalled oversized line or a rewrite behind an existing cursor', async () => {
        const f = await fixture();
        await writeFile(f.path, 'x'.repeat(MAX_AGENT_TRANSCRIPT_BYTES));
        expect(await f.read(0)).toMatchObject({ failure: 'payload_overflow' });
        await writeFile(f.path, 'short\n');
        expect(await f.read(1024)).toEqual({ content: '', failure: 'result_missing' });
    });
    it('never follows a foreign native identity or a symlink outside the provider root', async () => {
        const f = await fixture();
        const outside = join(f.home, 'outside.jsonl');
        await writeFile(outside, 'Synthetic private sentinel');
        await symlink(outside, f.path);
        expect(await f.read()).toEqual({ content: '' });
        expect(await f.read(undefined, 'foreign-session')).toEqual({ content: '' });
    });
});
