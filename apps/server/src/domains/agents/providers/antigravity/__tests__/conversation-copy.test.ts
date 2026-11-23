import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copyAntigravityConversation } from '../conversation-copy';
import { readAntigravityConversation } from '../conversation-database';
import { antigravityConversationPath } from '../paths';
import { writeAntigravityConversation } from './fixtures/conversation-database';

const ID = '0d5a5fdf-001d-44f8-b06c-ece668b72852';
const usage = { input: 100, output: 10 };

describe('copyAntigravityConversation', () => {
    let home: string;
    const environment = () => ({ homeDirectory: home, variables: {} });
    /**
     * The files in the conversations directory, without SQLite's write-ahead log companions.
     */
    const databases = async () =>
        (await readdir(join(home, '.gemini', 'antigravity-cli', 'conversations'))).filter(
            (name) => !name.endsWith('-wal') && !name.endsWith('-shm'),
        );

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-antigravity-copy-'));
        await writeAntigravityConversation(home, {
            id: ID,
            turns: [
                { prompt: 'first', reply: 'one', at: 1_790_000_000, usage },
                { prompt: 'second', reply: 'two', at: 1_790_000_010, usage },
                { prompt: 'third', reply: 'three', at: 1_790_000_020, usage },
            ],
        });
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    it('copies the turns before the cut under a new id and leaves the original whole', async () => {
        const originalPath = antigravityConversationPath(environment(), ID);
        const before = await readFile(originalPath);
        const copied = await copyAntigravityConversation(environment(), ID, {
            userTexts: ['second', 'third'],
        });
        if (copied.kind !== 'copied') throw new Error('Nothing was copied');
        expect(copied.conversationId).not.toBe(ID);

        const copyPath = antigravityConversationPath(environment(), copied.conversationId);
        expect(readAntigravityConversation(copyPath)).toMatchObject({
            messages: [
                { role: 'user', text: 'first' },
                { role: 'assistant', text: 'one' },
            ],
            // The original's usage stays the original's alone.
            generations: [],
        });
        const database = new Database(copyPath, { readonly: true });
        expect(database.prepare('SELECT cascade_id FROM trajectory_meta').all()).toEqual([
            { cascade_id: copied.conversationId },
        ]);
        database.close();
        expect(await readFile(originalPath)).toEqual(before);
        expect(readAntigravityConversation(originalPath)?.messages).toHaveLength(6);
    });

    it('copies the whole conversation without a cut', async () => {
        const copied = await copyAntigravityConversation(environment(), ID, undefined);
        if (copied.kind !== 'copied') throw new Error('Nothing was copied');
        const copy = readAntigravityConversation(
            antigravityConversationPath(environment(), copied.conversationId),
        );
        expect(copy?.messages.filter((message) => message.role === 'user')).toHaveLength(3);
    });

    it('copies nothing when the cut keeps no prompt', async () => {
        await expect(
            copyAntigravityConversation(environment(), ID, {
                userTexts: ['first', 'second', 'third'],
            }),
        ).resolves.toEqual({ kind: 'empty' });
        expect(await databases()).toEqual([`${ID}.db`]);
    });

    it.each([
        ['out of order', ['third', 'second']],
        ['unknown', ['missing']],
        ['longer than the record', ['zero', 'first', 'second', 'third']],
    ])(
        'refuses a cut the record does not end with (%s), and leaves no partial copy',
        async (_, userTexts) => {
            await expect(
                copyAntigravityConversation(environment(), ID, { userTexts }),
            ).rejects.toThrow(expect.objectContaining({ code: 'CONFLICT' }));
            expect(await databases()).toEqual([`${ID}.db`]);
        },
    );

    it('refuses an unknown conversation', async () => {
        await expect(
            copyAntigravityConversation(
                environment(),
                '11111111-2222-4333-8444-555555555555',
                undefined,
            ),
        ).rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        await expect(
            copyAntigravityConversation(environment(), '../escape', undefined),
        ).rejects.toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    });
});
