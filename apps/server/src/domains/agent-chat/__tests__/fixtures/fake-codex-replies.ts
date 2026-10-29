/**
 * Deterministic Codex replies for Chat rendering coverage: `table` streams the transcript's Markdown, `codeblocks`
 * streams fenced code in several languages, `testrun` finishes a multi-step turn whose command fails with a non-zero
 * exit code, `workrows` runs one command of each shell shape the work rows name (a skill read, chained reads, a file
 * search, a test run, a commit and push, and a pull request), `burststream` arrives in a few large deltas (with `clip`,
 * past the phone's clip and across a window re-read), `longstream` thinks quietly and then streams a long reply at a
 * reader's pace, `weblink` answers with a Markdown link to the web page the message names (`weblink inline` with its
 * bare URL after a label), `bigdiff` changes one file by 6,000 lines, and `widediff` changes one file with lines wider
 * than a phone, and `manysteps` runs {@link MANY_STEPS} quick commands before a short reply. `bigstream` and `toolstorm`
 * are the streaming benchmark's workloads (`e2e/agent-chat-streaming.performance.e2e.ts`): a 50 KB Markdown reply in
 * token-sized deltas, and {@link TOOL_STORM_COMMANDS} commands that each start and then finish.
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
 * The `thoughts` turn: three reasoning items in a row whose summaries are only bold titles, as Codex often emits them,
 * a command, two more such items, then a reply.
 */
export async function runConsecutiveThoughts(io: FakeCodexIo, turn: FakeTurn) {
    const thought = (summary: string[]) =>
        io.completeItem(turn, {
            type: 'reasoning',
            id: crypto.randomUUID(),
            summary,
            content: [],
        });
    thought(['**Analyzing detached submodule reasoning**']);
    thought(['**Clarifying submodule branch usage in worktrees**']);
    thought([
        '**Identifying incorrect detached submodule setup**\n\nThe worktree checks out a detached HEAD.',
    ]);
    io.completeItem(turn, {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: '/bin/zsh -lc "git status --short"',
        cwd: process.cwd(),
        status: 'completed',
        aggregatedOutput: ' M src/total.ts\n',
        exitCode: 0,
        durationMs: 1200,
    });
    thought(['**Planning branch ownership transfer**']);
    thought(['**Preparing concise branch transfer explanation**']);
    await io.streamMessage(turn, 'The submodule should track its own branch.', 0);
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
 * How many commands the `manysteps` turn runs: with its message and reply the turn holds 47 items, so a phone's 50-item
 * read cache cuts into the turn before it.
 */
const MANY_STEPS = 45;

/**
 * The `manysteps` turn: {@link MANY_STEPS} completed reads followed by a one-line reply.
 */
export async function runManySteps(io: FakeCodexIo, turn: FakeTurn) {
    for (let step = 1; step <= MANY_STEPS; step += 1) {
        io.completeItem(turn, {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: `/bin/zsh -lc "sed -n '1,40p' src/step-${step}.ts"`,
            cwd: process.cwd(),
            status: 'completed',
            aggregatedOutput: '',
            exitCode: 0,
            durationMs: 100,
        });
    }
    await io.streamMessage(turn, 'Read every step.', 0);
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
 * The `burststream` reply: seven paragraphs cut into 23 uneven deltas of 30 to 140 characters, long enough (about ten
 * seconds at 400ms apart) for a recording to show whether text keeps typing between deltas.
 */
const BURST_STREAM_DELTAS = [
    'Here is how the stream pacing works. Providers deliver ',
    'text in uneven bursts: a few words, then nothing for a while, then a whole sentence or two at once. ',
    'Drawing each burst as it lands makes a reply stutter.\n\n',
    'The pacer reveals what arrived a little behind it, ',
    'a share of the hidden text on every frame, so a burst eases in over a few frames while a steady stream stays only a few characters behind. ',
    'It never holds text back for long.\n\n',
    'On a phone the same stream crosses a cellular or VPN link, ',
    'and the network often hands it over in clumps: nothing for a few hundred milliseconds, ',
    'then several deltas together. ',
    'Draining each clump quickly and then waiting for the next one reads as blocks of text jumping in.\n\n',
    'So the pacer watches how far apart the clumps land ',
    'and how much text each one brings. ',
    'It stretches its window to cover the gap and keeps revealing at about the rate text arrives, ',
    'so the reply keeps typing between clumps instead of stopping.\n\n',
    'A paragraph that lands all at once still eases in over a few frames, ',
    'because the followed rate has a ceiling. ',
    'A long pause, such as a tool running or the model thinking, ',
    'teaches the pacer nothing about the link, so the next reply starts from the usual short window.\n\n',
    'Text that already arrived never waits long: ',
    'the window never stretches past a fraction of a second, ',
    'so a reader on a slow link sees the reply a moment late but never sees it stall.\n\n',
    'When the turn completes, fails, or is interrupted, ',
    'everything that arrived shows at once, so the reply is never left half drawn after the Agent has stopped.',
];

/**
 * The `burststreamclip` lead-in: 32 numbered lines of about 150 characters, which carry the reply past the phone's
 * 4,000-character clip before {@link CLIPPED_STREAM_LANDING} arrives.
 */
const CLIPPED_STREAM_LEAD_IN = Array.from(
    { length: 32 },
    (_, index) =>
        `Line ${String(index + 1).padStart(2, '0')}: the reply grows past what one phone window keeps, so the phone shows only its newest part behind a marker.\n\n`,
);

/**
 * The paragraph that arrives together with the oversized command output, so it is still easing in when the phone
 * re-reads its window.
 */
const CLIPPED_STREAM_LANDING = Array.from(
    { length: 8 },
    (_, index) =>
        `Sentence ${index + 1} of the landing paragraph arrived in the same moment as a command's large output, and keeps typing after the phone re-reads its window. `,
).join('');

/**
 * More than a phone frame holds (`MOBILE_AGENT_CHAT_MAX_BYTES`, 48 KiB), so the Gateway sends a content-free change
 * notice instead of the patch carrying it.
 */
const OVERSIZED_COMMAND_OUTPUT = `${'build output line\n'.repeat(3_500)}`;

/**
 * The `burststream` turn: {@link BURST_STREAM_DELTAS} 400ms apart. With `isClipped` (`burststreamclip`, #2682), the
 * reply first passes the phone's clip; then a command's output too large for one phone frame lands beside a long
 * paragraph of the reply, so the phone re-reads a window whose clipped reply starts later than the one it shows.
 */
export async function runBurstStream(
    io: FakeCodexIo,
    turn: FakeTurn,
    { isClipped }: { isClipped: boolean },
) {
    if (!isClipped) {
        await io.streamMessage(turn, BURST_STREAM_DELTAS, 400);
        return;
    }
    const reply = { type: 'agentMessage', id: crypto.randomUUID(), text: '' };
    io.startItem(turn, { ...reply });
    const say = (delta: string) => {
        reply.text += delta;
        io.notifyTurn(turn, 'item/agentMessage/delta', {
            turnId: turn.id,
            itemId: reply.id,
            delta,
        });
    };
    for (const line of CLIPPED_STREAM_LEAD_IN) {
        if (turn.interrupted) return;
        say(line);
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        await delay(400);
    }
    const command = {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: '/bin/zsh -lc "bun run build"',
        cwd: process.cwd(),
        status: 'inProgress',
    };
    io.startItem(turn, command);
    io.notifyTurn(turn, 'item/commandExecution/outputDelta', {
        turnId: turn.id,
        itemId: command.id,
        delta: OVERSIZED_COMMAND_OUTPUT,
    });
    say(CLIPPED_STREAM_LANDING);
    await delay(400);
    io.completeItem(turn, {
        ...command,
        status: 'completed',
        aggregatedOutput: OVERSIZED_COMMAND_OUTPUT,
        exitCode: 0,
        durationMs: 400,
    });
    const closing = BURST_STREAM_DELTAS.slice(-5);
    for (const delta of closing) {
        if (turn.interrupted) return;
        say(delta);
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        await delay(400);
    }
    io.completeItem(turn, reply);
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
 * Bytes the `bigstream` reply reaches, the size a long Agent answer with code and tables grows to.
 */
const BIG_STREAM_BYTES = 50 * 1024;
/**
 * Characters per `bigstream` delta: about the five or six tokens a provider stream carries per event.
 */
const BIG_STREAM_DELTA_CHARACTERS = 24;
/**
 * The pause between `bigstream` deltas: about ten seconds for the whole reply, a fast model's pace.
 */
const BIG_STREAM_DELTA_MS = 4;

/**
 * One section of the `bigstream` reply: a heading, prose with inline code and a file link, a list, a table, and a
 * fenced TypeScript block, so every block kind the transcript renders keeps growing while it streams.
 */
function bigStreamSection(index: number): string {
    const name = `step${String(index).padStart(3, '0')}`;
    return [
        `## Section ${index}: ${name}`,
        '',
        `The **${name}** change keeps \`src/${name}.ts\` in step with [the plan](src/plan.md:${index}), so the reply has prose, *emphasis*, and links to lay out while it grows.`,
        '',
        `- Read the current \`${name}\` state`,
        '- Apply the change and keep the tests green',
        `- Record the result in \`notes/${name}.md\``,
        '',
        '| Check | Result | Time |',
        '| :--- | :---: | ---: |',
        `| lint | pass | ${index % 7}.2 s |`,
        `| test | pass | ${index % 5}.8 s |`,
        '',
        '```ts',
        `export function ${name}(items: readonly number[]): number {`,
        '    let total = 0;',
        '    for (const item of items) total += item * 2;',
        `    return total + ${index};`,
        '}',
        '```',
        '',
    ].join('\n');
}

/**
 * The `bigstream` reply, cut into token-sized deltas.
 */
function bigStreamDeltas(): string[] {
    let text = '';
    for (let index = 1; text.length < BIG_STREAM_BYTES; index += 1) text += bigStreamSection(index);
    const deltas: string[] = [];
    for (let start = 0; start < text.length; start += BIG_STREAM_DELTA_CHARACTERS)
        deltas.push(text.slice(start, start + BIG_STREAM_DELTA_CHARACTERS));
    return deltas;
}

/**
 * The `bigstream` turn: a 50 KB Markdown reply streamed in token-sized deltas at a fast model's pace.
 */
export async function runBigStream(io: FakeCodexIo, turn: FakeTurn) {
    await io.streamMessage(turn, bigStreamDeltas(), BIG_STREAM_DELTA_MS);
}

/**
 * Commands the `toolstorm` turn runs; each starts and then finishes, so the Chat receives twice as many tool updates.
 */
const TOOL_STORM_COMMANDS = 300;
/**
 * The pause after each `toolstorm` update: about six seconds for the whole turn.
 */
const TOOL_STORM_UPDATE_MS = 10;

/**
 * The `toolstorm` turn: {@link TOOL_STORM_COMMANDS} commands that each report a running state and then finish with a
 * line of output, then a one-line reply.
 */
export async function runToolStorm(io: FakeCodexIo, turn: FakeTurn) {
    for (let step = 1; step <= TOOL_STORM_COMMANDS; step += 1) {
        if (turn.interrupted) return;
        const item = {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: `/bin/zsh -lc "rg -n 'step${step}' src"`,
            cwd: process.cwd(),
        };
        io.startItem(turn, { ...item, status: 'inProgress', aggregatedOutput: '' });
        // eslint-disable-next-line no-await-in-loop -- updates arrive one at a time on purpose
        await delay(TOOL_STORM_UPDATE_MS);
        io.completeItem(turn, {
            ...item,
            status: 'completed',
            aggregatedOutput: `src/step${step}.ts:${step}: export const step${step} = ${step};\n`,
            exitCode: 0,
            durationMs: TOOL_STORM_UPDATE_MS,
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await delay(TOOL_STORM_UPDATE_MS);
    }
    await io.streamMessage(turn, `Searched ${TOOL_STORM_COMMANDS} steps.`, 0);
}

/**
 * The text of the `weblink` reply's only link, long enough to wrap so a tap at its center lands on the link.
 */
export const FAKE_CODEX_WEB_LINK_LABEL =
    'Open the Acceptance fixture page in the in-app browser to check its toolbar';

/**
 * The words before the `weblink inline` reply's URL, as an Agent reports an Acceptance link.
 */
export const FAKE_CODEX_INLINE_LINK_PREFIX = 'Acceptance: ';

/**
 * The `weblink` reply: a Markdown link, and nothing else, to the first `http(s)` URL in the message. `weblink inline`
 * instead puts that URL as a CommonMark autolink after a label on the same line, the shape of an Agent's Acceptance
 * handoff, so the URL has to wrap with the text before it.
 */
export async function runWebLink(io: FakeCodexIo, turn: FakeTurn, text: string) {
    const url = /https?:\/\/\S+/u.exec(text)?.[0];
    const link = /\bweblink inline\b/u.test(text)
        ? `${FAKE_CODEX_INLINE_LINK_PREFIX}<${url}>`
        : `[${FAKE_CODEX_WEB_LINK_LABEL}](${url})`;
    await io.streamMessage(turn, url ? link : 'The message named no web page.', 0);
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
