import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { parseFakeClaudeScript } from './fixtures/fake-claude-script';
import { fileToolResult } from './fixtures/fake-claude-script-patch';

const ALL_STEPS = {
    model: { value: 'claude-opus-4-7', displayName: 'Opus 4.7' },
    turns: [
        {
            prompt: '  Do it  ',
            steps: [
                { kind: 'thinking', text: 'Think.' },
                {
                    kind: 'todos',
                    todos: [{ content: 'Read', status: 'pending', activeForm: 'Reading' }],
                },
                {
                    kind: 'tool',
                    name: 'Read',
                    input: {},
                    output: 'text',
                    isError: false,
                    durationMs: 5,
                },
                { kind: 'approval', name: 'Bash', input: { command: 'ls' }, output: 'a' },
                { kind: 'text', text: 'Done.', chunkDelayMs: 0 },
                { kind: 'hold', file: 'gate' },
                { kind: 'fail', message: 'Boom.' },
            ],
        },
    ],
};

describe('parseFakeClaudeScript', () => {
    it('accepts every step kind and trims prompts', () => {
        const script = parseFakeClaudeScript(structuredClone(ALL_STEPS));
        expect(script.turns[0].prompt).toBe('Do it');
        expect(script.turns[0].steps).toHaveLength(7);
        expect(script.model).toEqual({ value: 'claude-opus-4-7', displayName: 'Opus 4.7' });
    });

    const step = (override: Record<string, unknown>) => ({
        turns: [{ prompt: 'Go', steps: [{ kind: 'text', text: 'Hi.', ...override }] }],
    });

    it.each([
        ['a script that is not an object', [], 'script: expected an object'],
        [
            'an unknown top-level field',
            { turns: ALL_STEPS.turns, extra: 1 },
            'unknown field "extra"',
        ],
        ['no turns', { turns: [] }, 'turns: expected a non-empty array'],
        [
            'a model without a display name',
            { model: { value: 'x' }, turns: ALL_STEPS.turns },
            'model.displayName',
        ],
        [
            'a turn without steps',
            { turns: [{ prompt: 'Go', steps: [] }] },
            'turns[0].steps: expected a non-empty array',
        ],
        [
            'a blank prompt',
            { turns: [{ prompt: ' '.repeat(3), steps: ALL_STEPS.turns[0].steps }] },
            'turns[0].prompt: expected a non-empty string',
        ],
        [
            'a repeated prompt',
            {
                turns: [
                    { prompt: 'Go', steps: [{ kind: 'text', text: 'a' }] },
                    { prompt: ' Go ', steps: [{ kind: 'text', text: 'b' }] },
                ],
            },
            'turns[1].prompt: "Go" repeats an earlier prompt',
        ],
        [
            'an unknown step kind',
            step({ kind: 'speak' }),
            'turns[0].steps[0].kind: expected one of',
        ],
        [
            'a misspelled step field',
            step({ txt: 'oops' }),
            'turns[0].steps[0]: unknown field "txt"',
        ],
        [
            'an empty text step',
            step({ text: '' }),
            'turns[0].steps[0].text: expected a non-empty string',
        ],
        ['a negative chunk delay', step({ chunkDelayMs: -1 }), 'turns[0].steps[0].chunkDelayMs'],
        [
            'a tool step without input',
            { turns: [{ prompt: 'Go', steps: [{ kind: 'tool', name: 'Read', output: 'x' }] }] },
            'turns[0].steps[0].input: expected an object',
        ],
        [
            'a tool step without output',
            { turns: [{ prompt: 'Go', steps: [{ kind: 'tool', name: 'Read', input: {} }] }] },
            'turns[0].steps[0].output: expected a string',
        ],
        [
            'a todo with an unknown status',
            {
                turns: [
                    {
                        prompt: 'Go',
                        steps: [
                            {
                                kind: 'todos',
                                todos: [{ content: 'a', status: 'done', activeForm: 'b' }],
                            },
                        ],
                    },
                ],
            },
            'turns[0].steps[0].todos[0].status: expected pending, in_progress, or completed',
        ],
        [
            'a hold file that names a directory',
            { turns: [{ prompt: 'Go', steps: [{ kind: 'hold', file: '../gate' }] }] },
            'turns[0].steps[0].file: expected a file name without a directory',
        ],
        [
            'a fail step that is not last',
            {
                turns: [
                    {
                        prompt: 'Go',
                        steps: [
                            { kind: 'fail', message: 'x' },
                            { kind: 'text', text: 'y' },
                        ],
                    },
                ],
            },
            'turns[0].steps[0]: a fail step must be the last step of its turn',
        ],
    ])('rejects %s', (_name, script, problem) => {
        expect(() => parseFakeClaudeScript(script)).toThrow(problem);
    });
});

describe('fileToolResult', () => {
    async function project(files: Record<string, string> = {}) {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-patch-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        await mkdir(join(directory, 'src'));
        for (const [name, content] of Object.entries(files))
            // eslint-disable-next-line no-await-in-loop -- a few small files
            await writeFile(join(directory, name), content);
        return directory;
    }

    const FILE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', ''].join(
        '\n',
    );

    it('places an Edit in the file with three lines of context on each side', async () => {
        const directory = await project({ 'src/list.txt': FILE });
        const result = fileToolResult('Edit', {
            file_path: join(directory, 'src/list.txt'),
            old_string: 'five',
            new_string: '5',
        });
        expect(result).toMatchObject({
            oldString: 'five',
            newString: '5',
            userModified: false,
            replaceAll: false,
            structuredPatch: [
                {
                    oldStart: 2,
                    oldLines: 7,
                    newStart: 2,
                    newLines: 7,
                    lines: [' two', ' three', ' four', '-five', '+5', ' six', ' seven', ' eight'],
                },
            ],
        });
    });

    it('treats lines both sides of an Edit share as context, not as the change', async () => {
        const directory = await project({ 'src/list.txt': FILE });
        const result = fileToolResult('Edit', {
            file_path: join(directory, 'src/list.txt'),
            old_string: 'three\nfour\nfive',
            new_string: 'three\n4\nfive',
        });
        expect(result?.structuredPatch).toEqual([
            {
                oldStart: 1,
                oldLines: 7,
                newStart: 1,
                newLines: 7,
                lines: [' one', ' two', ' three', '-four', '+4', ' five', ' six', ' seven'],
            },
        ]);
    });

    it('keeps a line both sides share inside the change as context', async () => {
        const directory = await project({ 'src/list.txt': FILE });
        const result = fileToolResult('Edit', {
            file_path: join(directory, 'src/list.txt'),
            old_string: 'four\nfive\nsix',
            new_string: '4\nfive\n6',
        });
        expect(result?.structuredPatch).toEqual([
            {
                oldStart: 1,
                oldLines: 9,
                newStart: 1,
                newLines: 9,
                lines: [
                    ' one',
                    ' two',
                    ' three',
                    '-four',
                    '+4',
                    ' five',
                    '-six',
                    '+6',
                    ' seven',
                    ' eight',
                    ' nine',
                ],
            },
        ]);
    });

    it('finds the line numbers in a file that already holds the edit', async () => {
        const directory = await project({ 'src/list.txt': FILE.replace('five', '5') });
        const result = fileToolResult('Edit', {
            file_path: join(directory, 'src/list.txt'),
            old_string: 'five',
            new_string: '5',
        });
        expect(result?.structuredPatch).toMatchObject([
            {
                oldStart: 2,
                lines: [' two', ' three', ' four', '-five', '+5', ' six', ' seven', ' eight'],
            },
        ]);
    });

    it('places an appending Edit in a file that already holds it, though the old text is still there', async () => {
        const first = 'export function a() {\n    return 1;\n}';
        const second = 'export function b() {\n    return 2;\n}';
        const before = `// header\n\n${first}\n`;
        const after = `// header\n\n${first}\n\n${second}\n`;
        const input = { old_string: first, new_string: `${first}\n\n${second}` };
        const seededAfter = await project({ 'src/a.ts': after });
        const seededBefore = await project({ 'src/a.ts': before });
        const fromAfter = fileToolResult('Edit', {
            ...input,
            file_path: join(seededAfter, 'src/a.ts'),
        });
        const fromBefore = fileToolResult('Edit', {
            ...input,
            file_path: join(seededBefore, 'src/a.ts'),
        });
        expect(fromAfter?.structuredPatch).toEqual(fromBefore?.structuredPatch);
        expect(fromAfter?.structuredPatch).toMatchObject([{ oldStart: 3, newStart: 3 }]);
    });

    it('falls back to the input text when the file is missing or holds neither side', async () => {
        const directory = await project({ 'src/other.txt': 'unrelated\n' });
        for (const name of ['src/missing.txt', 'src/other.txt']) {
            const result = fileToolResult('Edit', {
                file_path: join(directory, name),
                old_string: 'a\nb',
                new_string: 'a\nc',
            });
            expect(result?.structuredPatch).toEqual([
                { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a', '-b', '+c'] },
            ]);
        }
    });

    it('reports a Write as a creation, or as an update of a different file', async () => {
        const directory = await project({ 'src/seeded.txt': 'new\n', 'src/old.txt': 'a\nb\n' });
        const created = fileToolResult('Write', {
            file_path: join(directory, 'src/fresh.txt'),
            content: 'new\n',
        });
        expect(created).toMatchObject({ type: 'create', structuredPatch: [], originalFile: null });
        // A Project seeded with the file the Chat reports writing still reads as a creation.
        expect(
            fileToolResult('Write', {
                file_path: join(directory, 'src/seeded.txt'),
                content: 'new\n',
            }),
        ).toMatchObject({ type: 'create', structuredPatch: [] });
        expect(
            fileToolResult('Write', {
                file_path: join(directory, 'src/old.txt'),
                content: 'a\nc\n',
            }),
        ).toMatchObject({
            type: 'update',
            originalFile: 'a\nb\n',
            structuredPatch: [{ oldStart: 1, lines: [' a', '-b', '+c'] }],
        });
    });

    it('has no structured result for other tools', () => {
        expect(fileToolResult('Read', { file_path: '/nowhere' })).toBeUndefined();
    });
});
