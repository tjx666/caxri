/**
 * Built-in `EnterWorktree` and `ExitWorktree` scenarios for the fake Claude Code CLI (`fake-claude-cli.ts`). Like the
 * real CLI, entering or leaving a worktree moves the process directory and relocates the session transcript to the
 * provider directory of the new directory, so a later `--resume` finds the conversation only when the CLI is launched
 * there. The tool results and the `PostToolUse` hook input follow the SDK's `EnterWorktreeOutput` and
 * `ExitWorktreeOutput` (`sdk-tools.d.ts`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { FakeClaudeIo } from './fake-claude-io.ts';

const COMMAND = /(enter|exit) worktree (\/\S+)/u;

function relocateTranscript(io: FakeClaudeIo, directory: string): void {
    const from = io.transcript();
    const projects = path.dirname(path.dirname(from));
    const to = path.join(projects, directory.replaceAll(/[^a-z0-9]/giu, '-'), path.basename(from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(from)) fs.renameSync(from, to);
    io.transcript(to);
    process.chdir(directory);
}

/**
 * `enter worktree <absolute path>` enters an existing worktree; `exit worktree <absolute path>` returns to that
 * original directory. Both reply with a short confirmation.
 */
export async function didRunWorktreeScenario(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
): Promise<boolean> {
    const match = COMMAND.exec(text);
    if (!match) return false;
    const [, verb, directory] = match;
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    const isEnter = verb === 'enter';
    io.assistant(`msg_${crypto.randomUUID()}`, {
        type: 'tool_use',
        id: toolUseId,
        name: isEnter ? 'EnterWorktree' : 'ExitWorktree',
        input: isEnter ? { path: directory } : { action: 'keep' },
    });
    relocateTranscript(io, directory);
    const message = isEnter ? `Switched to worktree ${directory}` : `Exited worktree`;
    await io.fireHook('PostToolUse', {
        tool_name: isEnter ? 'EnterWorktree' : 'ExitWorktree',
        tool_input: isEnter ? { path: directory } : { action: 'keep' },
        tool_response: isEnter
            ? { worktreePath: directory, message }
            : { action: 'keep', originalCwd: directory, worktreePath: directory, message },
        tool_use_id: toolUseId,
        cwd: directory,
    });
    io.toolResult(toolUseId, message);
    await io.didStreamFully(message, 0);
    io.result(startedAt, 'done');
    return true;
}
