/**
 * Deterministic Codex replies for Chat rendering coverage: `table` streams the transcript's Markdown, `codeblocks`
 * streams fenced code in several languages, and `testrun` finishes a multi-step turn whose command fails with a
 * non-zero exit code.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * The `table` reply: headings, nested and task lists, cited files, a quote, a table, and a fenced code block.
 */
const MARKDOWN_REPLY = [
    '## Summary',
    '',
    'Updated [app.ts](src/app.ts:2) and `src/app.ts#L1-L2`; see **the plan** below.',
    '',
    '### Plan',
    '',
    '1. Read the *current* state',
    '   - check `package.json`',
    '   - compare with ~~old~~ new',
    '2. Apply the fix',
    '',
    '- [x] Write tests',
    '- [ ] Ship it',
    '',
    '> Note: nothing outside the Project was touched.',
    '',
    'Background: [the Markdown guide](https://example.com/guide), https://example.com/faq, and [the tracking issue](https://github.com/octo-org/octo-repo/issues/1).',
    '',
    '| Option | Cost |',
    '| :--- | ---: |',
    '| Fast | 2 |',
    '| Safe | 5 |',
    '',
    '```ts',
    'const choice = "Safe";',
    'export function pick(cost: number): string {',
    '    return cost > 3 ? choice : "Fast";',
    '}',
    '```',
].join('\n');

export async function runMarkdownTable(io: FakeCodexIo, turn: FakeTurn) {
    await io.streamMessage(turn, MARKDOWN_REPLY, 5);
}

/**
 * The `codeblocks` reply: one fence per highlighted language, a fence without a language, and an indented block.
 */
const CODE_BLOCKS_REPLY = [
    'Here is the change in a few languages.',
    '',
    '```ts',
    'export function total(items: number[]): number {',
    '    return items.reduce((sum, item) => sum + item, 0);',
    '}',
    '```',
    '',
    '```bash',
    'npm test -- --run',
    'echo "exit: $?"',
    '```',
    '',
    '```json',
    '{ "name": "demo", "version": "1.0.0", "private": true }',
    '```',
    '',
    '```diff',
    '-const limit = 10;',
    '+const limit = 20;',
    '```',
    '',
    '```',
    'Plain text without a language.',
    '```',
    '',
    'An indented block:',
    '',
    '    let unchanged = true;',
].join('\n');

export async function runCodeBlocks(io: FakeCodexIo, turn: FakeTurn) {
    await io.streamMessage(turn, CODE_BLOCKS_REPLY, 5);
}

/**
 * The `testrun` turn: a thought, a test command that fails with exit code 1, a passing command, then a short reply.
 */
export async function runTestCommands(io: FakeCodexIo, turn: FakeTurn) {
    io.completeItem(turn, {
        type: 'reasoning',
        id: crypto.randomUUID(),
        summary: ['**Running the tests**\n\nCheck what fails first.'],
        content: [],
    });
    const ran = (command: string, output: string, exitCode: number) =>
        io.completeItem(turn, {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: `/bin/zsh -lc "${command}"`,
            cwd: process.cwd(),
            status: exitCode === 0 ? 'completed' : 'failed',
            aggregatedOutput: output,
            exitCode,
            durationMs: 1200,
        });
    ran('npm test', '1 failing\n  total() adds the items\n', 1);
    ran('git status --short', ' M src/total.ts\n', 0);
    await io.streamMessage(turn, 'One test fails in `src/total.ts`; the rest pass.', 0);
}
