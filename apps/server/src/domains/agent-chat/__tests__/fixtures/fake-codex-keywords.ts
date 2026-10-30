/**
 * The keyword scenarios of the fake Codex app-server (`fake-codex-app-server.ts`): a turn plays the first scenario
 * whose keyword its message contains.
 *
 * - `approve`: a command needing approval; accept runs it, decline records it as declined.
 * - `artifacts`: edits and creates files on disk, opens a pull request, rewrites another through `gh api`, files a Linear
 *   issue, and publishes an acceptance report.
 * - `manyfiles`: creates five notes on disk, so a turn card folds the files past its first rows.
 * - `patch`: a three-file change (update, add, delete) needing approval; nothing is written to disk.
 * - `bigdiff`: a completed file change whose diff is longer than Server Core keeps.
 * - `widediff`: a completed file change whose lines are wider than a phone, so a narrow diff view has to wrap them.
 * - `browsestep`: a Computer Use browser step that binds a tab, then one that drives it and stays running briefly before
 *   its result reports the browser surface.
 * - `ask`: a question; the reply quotes the chosen answer.
 * - `slow`: a titled thought, a running command, two token usage reports, and a long streamed reply that `turn/interrupt`
 *   can stop. With `reconnect`, a stream retry notice comes before the reply.
 * - `burststream`: a reply arriving in large deltas 400ms apart; `clip` adds a phone window re-read (#2682).
 * - `longstream`: a titled thought, a quiet pause of a few seconds, then a reply of forty numbered paragraphs streamed
 *   over about 30 seconds, which `turn/interrupt` can stop.
 * - `bigstream`: a 50 KB Markdown reply (headings, lists, tables, fenced code) in token-sized deltas over about ten
 *   seconds, the streaming benchmark's reply workload.
 * - `toolstorm`: 300 commands that each start and then finish, 600 tool updates over about six seconds, then a short
 *   reply: the streaming benchmark's tool workload.
 * - `richreply`: twenty pull requests and twenty issues opened through `gh`, forty edited files, then a reply of 120
 *   sections linking pull requests, issues, files, and a skill: the streaming benchmark's reference workload
 *   (`fake-codex-rich-reply.ts`).
 * - `proposeplan`: a plan-mode turn's proposed plan, a `plan` item that arrives whole with `item/completed`, so a Client
 *   can offer to build it.
 * - `weblink`: a reply that only links the message's first `http(s)` URL; matched before any keyword the URL may hold.
 * - `fail`: a failed turn with a provider error.
 * - `crash`: the process exits mid-turn, after saving the turn's user message as an interrupted turn.
 * - `table`: a reply exercising the transcript's Markdown: headings, nested and task lists, cited files, a quote, a
 *   table, and a fenced code block, streamed in small chunks.
 * - `codeblocks`: a reply with fenced code in `ts`, `bash`, `json`, and `diff`, a fence without a language, and an
 *   indented code block, so a Client's syntax highlighting can be compared across languages.
 * - `testrun`: a finished multi-step turn: a thought, a test command that exits with code 1, a passing command, and a
 *   short reply, so a Client folds the work behind its `Worked for` row and shows the failed command's exit code.
 * - `manyagents`: seven `spawnAgent` calls with long titles, each child finishing before the next, then one `wait` for
 *   all of them, so a finished turn's fold row carries more subagents than fit beside its `Worked for` label.
 * - `subagent`: a `spawnAgent` collab call whose child thread runs its own turn (notifications with the child's
 *   `threadId`, some before the spawn completes, as real Codex sends them), then a `wait` call reporting its result.
 *   With `hold`, the child keeps streaming until `turn/interrupt` stops it and the parent turn ends right away; with
 *   `waiting` as well, the parent instead stays in a `wait` call that only a `turn/steer` ends. With `browsestep`, the
 *   child runs the `browsestep` steps first.
 * - `background`: a unified-exec command (with a `processId`) that outlives its turn, streaming output until
 *   `thread/backgroundTerminals/terminate` stops it. With `flood`, it emits Codex's 10,000 output deltas at once; with
 *   `quiet`, it prints one line a second instead of one every 30 ms, so a phone screen showing it can settle.
 * - `autocompact`: the turn compacts its context on its own for 40 seconds, holding steered messages until it ends
 *   (`fake-codex-autocompact.ts`).
 * - `vanish`: every background terminal disappears from `thread/backgroundTerminals/list` without a notification.
 * - `unannounced`: a background terminal only `thread/backgroundTerminals/list` reports.
 * - Anything else: reasoning, a plan, and a streamed reply quoting the message.
 */
import {
    runApprovalCommand,
    runApprovalPatch,
    runQuestion,
    runQuestions,
} from './fake-codex-approvals.ts';
import { runTurnArtifacts, runTurnManyFiles } from './fake-codex-artifacts.ts';
import { runAutoCompact } from './fake-codex-autocompact.ts';
import { runDefaultReply } from './fake-codex-default-reply.ts';
import { runExplore, runParallelExplore } from './fake-codex-explore.ts';
import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';
import { runBrowserStep } from './fake-codex-mcp-calls.ts';
import {
    runBigDiff,
    runBigStream,
    runBurstStream,
    runCodeBlocks,
    runConsecutiveThoughts,
    runLongStream,
    runManySteps,
    runMarkdownTable,
    runProposedPlan,
    runTestCommands,
    runToolStorm,
    runWebLink,
    runWideDiff,
    runWorkRowCommands,
} from './fake-codex-replies.ts';
import { runRichReply } from './fake-codex-rich-reply.ts';
import { runSlow } from './fake-codex-slow.ts';
import {
    dropTerminalsSilently,
    runBackgroundCommand,
    runManySubagents,
    runSubagent,
    startUnannouncedTerminal,
} from './fake-codex-tasks.ts';
import { failOnUsageLimit } from './fake-codex-usage-limit.ts';

/**
 * Plays the scenario `text` selects. `said` is the message as typed, which the default reply quotes; `text` is empty
 * for a delegation pointer, so it selects no scenario.
 */
export async function runKeywordScenario(
    io: FakeCodexIo,
    turn: FakeTurn,
    { text, said, imageCount }: { text: string; said: string; imageCount: number },
) {
    if (imageCount > 0) {
        await io.streamMessage(
            turn,
            `Received ${imageCount} image${imageCount === 1 ? '' : 's'}.`,
            0,
        );
    } else if (text.includes('weblink')) {
        await runWebLink(io, turn, text);
    } else if (text.includes('proposeplan')) {
        runProposedPlan(io, turn);
    } else if (text.includes('burststream')) {
        await runBurstStream(io, turn, { isClipped: text.includes('clip') });
    } else if (text.includes('longstream')) {
        await runLongStream(io, turn);
    } else if (text.includes('bigstream')) {
        await runBigStream(io, turn);
    } else if (text.includes('toolstorm')) {
        await runToolStorm(io, turn);
    } else if (text.includes('richreply')) {
        await runRichReply(io, turn);
    } else if (text.includes('manyagents')) {
        await runManySubagents(io, turn);
    } else if (text.includes('subagent')) {
        await runSubagent(io, turn, {
            isHeld: text.includes('hold'),
            isWaiting: text.includes('waiting'),
            isBrowsing: text.includes('browsestep'),
        });
    } else if (text.includes('vanish')) {
        dropTerminalsSilently();
        await io.streamMessage(turn, 'Done.', 0);
    } else if (text.includes('unannounced')) {
        startUnannouncedTerminal(turn);
        await io.streamMessage(turn, 'Done.', 0);
    } else if (text.includes('background')) {
        await runBackgroundCommand(io, turn, {
            isFlood: text.includes('flood'),
            tickMs: text.includes('quiet') ? 1_000 : 30,
        });
    } else if (text.includes('approve')) {
        await runApprovalCommand(io, turn);
    } else if (text.includes('artifacts')) {
        await runTurnArtifacts(io, turn);
    } else if (text.includes('manyfiles')) {
        await runTurnManyFiles(io, turn);
    } else if (text.includes('patch')) {
        await runApprovalPatch(io, turn);
    } else if (text.includes('widediff')) {
        await runWideDiff(io, turn);
    } else if (text.includes('bigdiff')) {
        await runBigDiff(io, turn);
    } else if (text.includes('browsestep')) {
        await runBrowserStep(io, turn);
    } else if (text.includes('parallel')) {
        await runParallelExplore(io, turn);
    } else if (text.includes('explore')) {
        await runExplore(io, turn, text.includes('gradual'));
    } else if (text.includes('several questions') || text.includes('askmany')) {
        // `askmany` is the one-word form a phone can type: `adb input text` drops spaces.
        await runQuestions(io, turn);
    } else if (text.includes('ask')) {
        await runQuestion(io, turn);
    } else if (text.includes('autocompact')) {
        await runAutoCompact(io, turn);
    } else if (text.includes('slow')) {
        await runSlow(io, turn, text.includes('reconnect'));
    } else if (text.includes('codeblocks')) {
        await runCodeBlocks(io, turn);
    } else if (text.includes('thoughts')) {
        await runConsecutiveThoughts(io, turn);
    } else if (text.includes('testrun')) {
        await runTestCommands(io, turn);
    } else if (text.includes('manysteps')) {
        await runManySteps(io, turn);
    } else if (text.includes('workrows')) {
        await runWorkRowCommands(io, turn);
    } else if (text.includes('table')) {
        await runMarkdownTable(io, turn);
    } else if (text.includes('usage exhausted')) {
        failOnUsageLimit(io, turn, text);
    } else if (text.includes('fail')) {
        turn.status = 'failed';
        turn.error = { message: 'Fake provider failure' };
        io.notifyTurn(turn, 'error', { turnId: turn.id, willRetry: false, error: turn.error });
    } else {
        await runDefaultReply(io, turn, said);
    }
}
