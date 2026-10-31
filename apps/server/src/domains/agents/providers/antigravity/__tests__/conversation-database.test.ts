import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    antigravityConversationId,
    antigravityConversationStamp,
    readAntigravityConversation,
    readAntigravityConversationSummary,
} from '../conversation-database';
import { decodeWireFields } from '../protobuf-wire';
import { encodeMessage, writeAntigravityConversation } from './fixtures/conversation-database';

const ID = '0d5a5fdf-001d-44f8-b06c-ece668b72852';
const PROJECT = '/workspace/demo-app';

describe('Antigravity conversation database', () => {
    let home: string;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-antigravity-db-'));
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    it('reads visible messages, per-call usage, and step times without thinking text', async () => {
        const path = await writeAntigravityConversation(home, {
            id: ID,
            cwd: PROJECT,
            title: 'Fix invoice rounding',
            turns: [
                {
                    prompt: 'Why does the invoice total drift?',
                    reply: 'Rounding happens per line item.',
                    at: 1_790_000_000,
                    model: 'gemini-3-flash',
                    usage: { input: 1200, output: 300, cacheRead: 4000, reasoning: 200 },
                },
                { prompt: 'Thanks', at: 1_790_000_100 },
            ],
        });
        await chmod(path, 0o444);

        const conversation = readAntigravityConversation(path);

        expect(conversation).toEqual({
            source: 17,
            messages: [
                { role: 'user', text: 'Why does the invoice total drift?' },
                { role: 'assistant', text: 'Rounding happens per line item.' },
                { role: 'user', text: 'Thanks' },
            ],
            generations: [
                {
                    index: 0,
                    at: 1_790_000_001_000,
                    model: 'gemini-3-flash',
                    input: 1200,
                    output: 300,
                    cacheRead: 4000,
                    cacheWrite: 0,
                    reasoning: 200,
                },
            ],
            activity: [1_790_000_000_000, 1_790_000_001_000, 1_790_000_100_000],
        });
        expect(JSON.stringify(conversation)).not.toContain('thinking');
        expect(
            readAntigravityConversationSummary({ homeDirectory: home, variables: {} }, ID),
        ).toEqual({ cwd: PROJECT, title: 'Fix invoice rounding' });
    });

    it('reads a file that is not a database as no conversation', async () => {
        const path = join(home, 'broken.db');
        await writeFile(path, 'not sqlite');
        expect(readAntigravityConversation(path)).toBeUndefined();
        expect(readAntigravityConversation(join(home, 'missing.db'))).toBeUndefined();
    });

    it('covers the write-ahead log in the conversation stamp', async () => {
        const path = await writeAntigravityConversation(home, { id: ID, turns: [] });
        const before = await antigravityConversationStamp(path);
        await writeFile(`${path}-wal`, 'x'.repeat(128));
        const after = await antigravityConversationStamp(path);
        expect(after?.size).toBe((before?.size ?? 0) + 128);
    });

    it('accepts only conversation id file names', () => {
        expect(antigravityConversationId(`${ID}.db`)).toBe(ID);
        expect(antigravityConversationId(`${ID}.db-wal`)).toBeUndefined();
        expect(antigravityConversationId('conversation_summaries.db')).toBeUndefined();
    });

    it('stops at a truncated field instead of throwing', () => {
        const message = encodeMessage([
            [1, 15],
            [20, 'answer'],
        ]);
        expect(decodeWireFields(message.subarray(0, -2))).toEqual([{ number: 1, varint: 15 }]);
    });
});
