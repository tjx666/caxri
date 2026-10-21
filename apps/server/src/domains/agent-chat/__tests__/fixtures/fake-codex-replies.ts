/**
 * Deterministic Codex replies for Chat rendering coverage: `table` streams the transcript's Markdown, `codeblocks`
 * streams fenced code in several languages, `testrun` finishes a multi-step turn whose command fails with a non-zero
 * exit code, `workrows` runs one command of each shell shape the work rows name (a skill read, chained reads, a file
 * search, a test run, a commit and push, and a pull request), `burststream` arrives in a few large deltas, `longstream`
 * thinks quietly and then streams a long reply at a reader's pace, and `weblink` answers with a Markdown link to the
 * web page the message names, `bigdiff` changes one file by 6,000 lines, and `widediff` changes one file with lines
 * wider than a phone.
 */
import crypto from 'node:crypto';
import path from 'node:path';
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

/**
 * The `workrows` turn: one completed command per recognized shell shape, wrapped the way Agents run them (`rtk`,
 * `bunx`, chained with `&&`).
 */
export async function runWorkRowCommands(io: FakeCodexIo, turn: FakeTurn) {
    const commands = [
        'cat .agents/skills/review/SKILL.md',
        "sed -n '1,80p' src/total.ts && sed -n '1,40p' src/cart.ts",
        "rg --files src | rg 'total'",
        'rtk vitest run src/total.test.ts',
        "rtk git commit -m 'fix: add the item totals' && rtk git push",
        "gh pr create --title 'Fix the item totals' --body-file /tmp/body.md",
    ];
    for (const command of commands) {
        io.completeItem(turn, {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: `/bin/zsh -lc "${command}"`,
            cwd: process.cwd(),
            status: 'completed',
            aggregatedOutput: '',
            exitCode: 0,
            durationMs: 800,
        });
    }
    await io.streamMessage(turn, 'Fixed the totals and opened a pull request.', 0);
}

/**
 * How long the `longstream` turn holds a quiet thought before its reply starts. A phone Acceptance case reads the
 * pinned layout through UIAutomator in this window, which a streaming reply would keep from settling.
 */
const LONG_STREAM_PAUSE_MS = 8_000;

/**
 * The pause between the `longstream` reply's words: about 30 seconds for the whole reply, long enough to scroll away
 * while it still grows.
 */
const LONG_STREAM_WORD_MS = 50;

const LONG_STREAM_REPLY = Array.from(
    { length: 40 },
    (_, index) =>
        `Paragraph ${String(index + 1).padStart(2, '0')}: the reply keeps growing below the message while the reader looks elsewhere.`,
).join('\n\n');

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `burststream` reply: three paragraphs cut into uneven deltas of 40 to 160 characters.
 */
const BURST_STREAM_DELTAS = [
    'Here is how the stream pacing works. Providers deliver ',
    'text in uneven bursts: a few words, then nothing for a while, then a whole sentence or two at once. ',
    'Drawing each burst as it lands makes a reply stutter.\n\n',
    'The pacer reveals what arrived a little behind it, ',
    'a share of the hidden text on every frame, so a burst eases in over a few frames while a steady stream stays only a few characters behind. ',
    'It never holds text back for long.\n\n',
    'When the turn completes, fails, or is interrupted, ',
    'everything that arrived shows at once, so the reply is never left half drawn after the Agent has stopped.',
];

/**
 * The `burststream` turn: {@link BURST_STREAM_DELTAS} 400ms apart.
 */
export async function runBurstStream(io: FakeCodexIo, turn: FakeTurn) {
    await io.streamMessage(turn, BURST_STREAM_DELTAS, 400);
}

/**
 * The `longstream` turn: a titled thought, a quiet pause, then forty numbered paragraphs streamed word by word.
 * `turn/interrupt` stops it during the pause or the reply.
 */
export async function runLongStream(io: FakeCodexIo, turn: FakeTurn) {
    io.completeItem(turn, {
        type: 'reasoning',
        id: crypto.randomUUID(),
        summary: ['**Drafting a long reply**\n\nThink before writing.'],
        content: [],
    });
    const deadline = Date.now() + LONG_STREAM_PAUSE_MS;
    // eslint-disable-next-line no-await-in-loop -- the pause polls so an interrupt ends it promptly
    while (!turn.interrupted && Date.now() < deadline) await delay(100);
    if (turn.interrupted) return;
    await io.streamMessage(turn, LONG_STREAM_REPLY, LONG_STREAM_WORD_MS);
}

/**
 * The text of the `weblink` reply's only link, long enough to wrap so a tap at its center lands on the link.
 */
export const FAKE_CODEX_WEB_LINK_LABEL =
    'Open the Acceptance fixture page in the in-app browser to check its toolbar';

/**
 * The `weblink` reply: a Markdown link, and nothing else, to the first `http(s)` URL in the message.
 */
export async function runWebLink(io: FakeCodexIo, turn: FakeTurn, text: string) {
    const url = /https?:\/\/\S+/u.exec(text)?.[0];
    await io.streamMessage(
        turn,
        url ? `[${FAKE_CODEX_WEB_LINK_LABEL}](${url})` : 'The message named no web page.',
        0,
    );
}

/**
 * `bigdiff`: one file change of 6,000 added lines, so the Chat's diff view has to bound what it renders.
 */
export async function runBigDiff(io: FakeCodexIo, turn: FakeTurn) {
    const lineCount = 6000;
    const lines = Array.from(
        { length: lineCount },
        (_, index) => `+generated line ${String(index + 1).padStart(5, '0')}`,
    );
    io.completeItem(turn, {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'completed',
        changes: [
            {
                path: path.join(process.cwd(), 'generated.txt'),
                kind: { type: 'update', move_path: null },
                diff: [`@@ -0,0 +1,${lineCount} @@`, ...lines, ''].join('\n'),
            },
        ],
    });
    await io.streamMessage(turn, 'Generated a large file.', 0);
}

/**
 * `widediff`: a short edit whose lines are wider than a phone screen, a sentence of prose and an indented call, so a
 * narrow diff view shows whether it wraps them or makes the reader pan.
 */
export async function runWideDiff(io: FakeCodexIo, turn: FakeTurn) {
    io.completeItem(turn, {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'completed',
        changes: [
            {
                path: path.join(process.cwd(), 'src', 'welcome.ts'),
                kind: { type: 'update', move_path: null },
                diff: [
                    '@@ -8,4 +8,5 @@',
                    ' export function welcome(user: User) {',
                    '-    return formatGreeting(user.name);',
                    '+    // Greet returning users by name and first-time visitors with the onboarding line instead.',
                    "+    return user.isReturning ? formatGreeting(user.name, { punctuation: '!' }) : ONBOARDING_LINE;",
                    ' }',
                    '',
                ].join('\n'),
            },
        ],
    });
    await io.streamMessage(turn, 'Updated the welcome line.', 0);
}
