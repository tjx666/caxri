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
 * Claude Code's built-in `/goal`, with its local command reply. `/goal <condition>` keeps its query going, as the
 * goal's Stop hook does while the condition is unmet, until an interrupt ends it with the goal still set; `/goal clear`
 * drops the goal without a model request. Like every input, a `/goal clear` sent during the goal's query waits until
 * that query ends. Returns whether `text` was a `/goal` command.
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
    for (let chunk = 0; chunk < MAX_GOAL_CHUNKS; chunk += 1) {
        // eslint-disable-next-line no-await-in-loop -- the goal's query streams one chunk at a time on purpose
        if (!(await io.didStreamFully('Still working toward the goal. ', 50))) break;
    }
    io.result(startedAt, 'interrupted', true);
    return true;
}
