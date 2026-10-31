import type { FakeClaudeIo } from './fake-claude-io';

/**
 * Upper bound on the chunks a goal's query streams, so a test that never stops it fails instead of hanging.
 */
const MAX_GOAL_CHUNKS = 600;

/**
 * The goal this process holds, as Claude Code keeps it for the session.
 */
const session: { goal?: string } = {};

/**
 * How the goal's evaluator settles a condition naming one of these words, as the `goal_status` attachment Claude Code
 * writes only to the transcript (verified with Claude Code 2.1.312). Any other condition stays unmet until
 * interrupted.
 */
const SETTLED_GOALS: Record<string, Record<string, unknown>> = {
    achievable: { met: true, reason: 'The condition holds: every check reported success.' },
    impossible: {
        met: false,
        failed: true,
        reason: 'The condition needs access this session does not have, so it cannot be met.',
    },
};

/**
 * Claude Code's built-in `/goal`, with its local command reply. `/goal <condition>` keeps its query going, as the
 * goal's Stop hook does while the condition is unmet, until an interrupt ends it with the goal still set; `/goal clear`
 * drops the goal without a model request. Like every input, a `/goal clear` sent during the goal's query waits until
 * that query ends. A condition naming a `SETTLED_GOALS` word instead ends its query once the evaluator settles it.
 * Returns whether `text` was a `/goal` command.
 */
export async function didRunGoalCommand(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
): Promise<boolean> {
    const command = text.trim();
    if (command !== '/goal' && !command.startsWith('/goal ')) return false;
    const arguments_ = command.slice('/goal'.length).trim();
    const reply = (stdout: string) =>
        io.send(
            io.frame({
                type: 'assistant',
                message: { content: [] },
                local_command_run: { command: 'goal', args: arguments_ },
                local_command_source: `<local-command-stdout>${stdout}</local-command-stdout>`,
            }),
        );
    if (arguments_ === 'clear') {
        reply(session.goal === undefined ? 'No goal set' : `Goal cleared: ${session.goal}`);
        session.goal = undefined;
        io.result(startedAt, '');
        return true;
    }
    session.goal = arguments_;
    reply(`Goal set: ${arguments_}`);
    const settled = Object.entries(SETTLED_GOALS).find(([word]) => arguments_.includes(word))?.[1];
    if (settled) {
        await io.didStreamFully('Checked the goal. ', 50);
        io.record({
            type: 'attachment',
            attachment: {
                type: 'goal_status',
                condition: arguments_,
                iterations: 1,
                durationMs: 42_000,
                tokens: 1_200,
                ...settled,
            },
        });
        session.goal = undefined;
        io.result(startedAt, 'Checked the goal.');
        return true;
    }
    for (let chunk = 0; chunk < MAX_GOAL_CHUNKS; chunk += 1) {
        // eslint-disable-next-line no-await-in-loop -- the goal's query streams one chunk at a time on purpose
        if (!(await io.didStreamFully('Still working toward the goal. ', 50))) break;
    }
    io.result(startedAt, 'interrupted', true);
    return true;
}
