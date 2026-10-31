import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import {
    antigravityDelegationAdapter,
    extractAntigravityDelegationCompletion,
} from '../delegation';
import { writeAntigravityConversation } from './fixtures/conversation-database';

const evidence = {
    sessionId: 'synthetic-conversation',
    turnId: 'step-4',
    promptDigest: createHash('sha256').update('Synthetic pointer').digest('hex'),
};
const line = (role: 'user' | 'assistant', text: string) => JSON.stringify({ role, text });
const transcript = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('Antigravity delegation completion', () => {
    it("answers with the last reply before the next user message, under the Stop's turn", () => {
        const content = transcript(
            line('user', 'Earlier task'),
            line('assistant', 'Earlier answer'),
            line('user', 'Synthetic pointer'),
            line('assistant', 'Reading the task file'),
            line('assistant', 'Final answer'),
            line('user', 'Later message'),
            line('assistant', 'Later answer'),
        );
        expect(extractAntigravityDelegationCompletion(content, evidence)).toEqual({
            kind: 'answer',
            text: 'Final answer',
            messageId: 'step-4',
        });
    });

    it("reads the pointer's latest occurrence in a resumed conversation", () => {
        const content = transcript(
            line('user', 'Synthetic pointer'),
            line('assistant', 'First run'),
            line('user', 'Synthetic pointer'),
            line('assistant', 'Second run'),
        );
        expect(extractAntigravityDelegationCompletion(content, evidence)).toMatchObject({
            text: 'Second run',
        });
    });

    it('waits without a turn, a matching prompt, or a reply', () => {
        const answered = transcript(line('user', 'Synthetic pointer'), line('assistant', 'Done'));
        expect(
            extractAntigravityDelegationCompletion(answered, { ...evidence, turnId: undefined }),
        ).toBeUndefined();
        const otherTask = transcript(line('user', 'Another task'), line('assistant', 'Done'));
        expect(extractAntigravityDelegationCompletion(otherTask, evidence)).toBeUndefined();
        const unanswered = transcript(line('user', 'Synthetic pointer'));
        expect(extractAntigravityDelegationCompletion(unanswered, evidence)).toBeUndefined();
    });

    it('ignores malformed lines', () => {
        const content = [
            'not json',
            'null',
            line('user', 'Synthetic pointer'),
            '{"role":"assistant"}',
            line('assistant', 'Done'),
        ].join('\n');
        expect(extractAntigravityDelegationCompletion(content, evidence)).toMatchObject({
            text: 'Done',
        });
    });
});

describe('Antigravity delegation adapter', () => {
    it('waits for Stop before collecting and lets agy choose the conversation id', () => {
        expect(antigravityDelegationAdapter).toMatchObject({
            completion: 'native-completion',
            completionAwaitsStop: true,
        });
        expect(antigravityDelegationAdapter.createSessionId()).toBeUndefined();
    });

    it('accepts Antigravity CLI 1.4.11 or later within major 1', () => {
        for (const version of ['1.4.11', 'agy 1.4.12', '1.9.0'])
            expect(() => antigravityDelegationAdapter.verifyVersion(version)).not.toThrow();
        for (const version of ['1.4.10', '2.0.0', undefined])
            expect(() => antigravityDelegationAdapter.verifyVersion(version)).toThrow(
                /Antigravity CLI 1\.4\.11\+/,
            );
    });

    it("answers from the conversation database's visible messages", async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-antigravity-delegation-'));
        onTestFinished(() => rm(home, { recursive: true, force: true }));
        const id = '0d5a5fdf-001d-44f8-b06c-ece668b72852';
        await writeAntigravityConversation(home, {
            id,
            cwd: '/workspace/demo-app',
            turns: [{ prompt: 'Synthetic pointer', reply: 'Final answer', at: 1_790_000_000 }],
        });
        const environment = { homeDirectory: home, variables: {} };

        const content = await antigravityDelegationAdapter.readTranscript!(id, environment);
        expect(
            antigravityDelegationAdapter.extractCompletion(content!, {
                ...evidence,
                sessionId: id,
            }),
        ).toMatchObject({ kind: 'answer', text: 'Final answer' });
        expect(
            await antigravityDelegationAdapter.readTranscript!('missing', environment),
        ).toBeUndefined();
    });

    it('replaces the model and effort a delegation selects', () => {
        expect(
            antigravityDelegationAdapter.selectLaunch(
                {
                    executable: 'agy',
                    args: ['--model', 'old', '--effort=low', '--dangerously-skip-permissions'],
                },
                { provider: 'antigravity', model: 'gemini-3.8-pro', effort: 'high' },
            ).args,
        ).toEqual([
            '--dangerously-skip-permissions',
            '--model',
            'gemini-3.8-pro',
            '--effort',
            'high',
        ]);
    });
});
