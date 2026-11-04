import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { DELEGATION_QUESTION_COMMANDS } from '../question';

const command = (method: string) =>
    DELEGATION_QUESTION_COMMANDS.find((item) => item.method === method)!;

describe('delegation question CLI', () => {
    it('asks with flags only, trimming options and keeping a request ID', async () => {
        const ask = command('agent.delegation.ask');

        expect(ask.path).toEqual(['agent', 'delegate', 'ask']);
        expect(await ask.parseParams(['--text', 'Which branch?'])).toEqual({
            text: 'Which branch?',
        });
        expect(
            await ask.parseParams([
                '--text',
                'Which branch?',
                '--option',
                ' main ',
                '--option',
                'dev',
                '--request-id',
                'req-1',
            ]),
        ).toEqual({ text: 'Which branch?', options: ['main', 'dev'], requestId: 'req-1' });
    });

    it('rejects a missing or doubled question source and bad options', async () => {
        const ask = command('agent.delegation.ask');

        await expect(ask.parseParams([])).rejects.toThrow(/exactly one of --text or --file/u);
        await expect(ask.parseParams(['--text', 'a', '--file', 'b'])).rejects.toThrow(
            /exactly one/u,
        );
        await expect(ask.parseParams(['positional'])).rejects.toThrow(/requires a value/u);
        await expect(ask.parseParams(['--text', 'a', '--bogus', 'b'])).rejects.toThrow(
            /--text <text> or --file/u,
        );
        await expect(
            ask.parseParams(['--text', 'a', '--option', 'x', '--option', 'x']),
        ).rejects.toThrow(/different/u);
        await expect(ask.parseParams(['--text', 'a', '--option', '  '])).rejects.toThrow(
            /1-120 characters/u,
        );
        await expect(ask.parseParams(['--text', 'a', '--option', 'x'.repeat(121)])).rejects.toThrow(
            /1-120 characters/u,
        );
        await expect(
            ask.parseParams([
                '--text',
                'a',
                ...Array.from({ length: 7 }, (_, index) => ['--option', `o${index}`]).flat(),
            ]),
        ).rejects.toThrow(/at most 6/u);
        await expect(
            ask.parseParams(['--text', 'a', '--request-id', 'r', '--request-id', 's']),
        ).rejects.toThrow(/at most once/u);
        await expect(ask.parseParams(['--text', 'x'.repeat(2001)])).rejects.toThrow();
    });

    it('reads a long question or answer from a bounded file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-question-cli-'));
        onTestFinished(() => rm(directory, { force: true, recursive: true }));
        const path = join(directory, 'text.md');
        await writeFile(path, 'Synthetic question');

        expect(await command('agent.delegation.ask').parseParams(['--file', path])).toEqual({
            text: 'Synthetic question',
        });
        expect(
            await command('agent.delegation.answer').parseParams(['task-1', 'q-1', '--file', path]),
        ).toEqual({ delegationId: 'task-1', questionId: 'q-1', text: 'Synthetic question' });

        await writeFile(path, 'a'.repeat(8001));
        await expect(command('agent.delegation.ask').parseParams(['--file', path])).rejects.toThrow(
            /regular file/u,
        );
    });

    it('takes one question ID for ask-wait and ask-cancel', () => {
        for (const method of ['agent.delegation.askWait', 'agent.delegation.askCancel']) {
            const item = command(method);
            expect(item.parseParams(['q-1'])).toEqual({ questionId: 'q-1' });
            expect(() => item.parseParams([])).toThrow(/one question ID/u);
            expect(() => item.parseParams(['q-1', 'q-2'])).toThrow(/one question ID/u);
            expect(() => item.parseParams(['--json'])).toThrow(/one question ID/u);
        }
    });

    it('lists questions of every task or of one', () => {
        const questions = command('agent.delegation.questions');

        expect(questions.parseParams([])).toEqual({});
        expect(questions.parseParams(['task-1'])).toEqual({ delegationId: 'task-1' });
        expect(() => questions.parseParams(['a', 'b'])).toThrow(/at most one/u);
        expect(() => questions.parseParams(['--all'])).toThrow(/delegation ID/u);
    });

    it('answers with the delegation, question and one text source', async () => {
        const answer = command('agent.delegation.answer');

        expect(await answer.parseParams(['task-1', 'q-1', '--text', 'main'])).toEqual({
            delegationId: 'task-1',
            questionId: 'q-1',
            text: 'main',
        });
        await expect(answer.parseParams(['task-1', 'q-1'])).rejects.toThrow(/exactly one/u);
        await expect(answer.parseParams(['task-1'])).rejects.toThrow();
        await expect(answer.parseParams(['--text', 'x', 'q-1', 'y'])).rejects.toThrow(
            /delegation ID/u,
        );
        await expect(
            answer.parseParams(['task-1', 'q-1', '--text', 'x'.repeat(4001)]),
        ).rejects.toThrow();
    });
});
