/**
 * The fake Claude Code CLI's default reply: thinking, a task list, and streamed text.
 */
import crypto from 'node:crypto';

import type { FakeClaudeIo } from './fake-claude-io.ts';

/**
 * Streams thinking, a `TodoWrite` plan, and `Hello from fake Claude. <reply>`, leaving the turn's result to the caller.
 */
export async function streamPlannedReply(io: FakeClaudeIo, reply: string) {
    if (reply.includes('synthetic feedback')) {
        io.system('hook_response', {
            hook_name: 'SessionStart:startup',
            outcome: 'error',
            exit_code: 1,
            stderr: 'Example configuration could not be read.\nCheck the test configuration file.',
            stdout: '',
            output: '',
        });
        // Claude Code 2.1.304 reports a UserPromptSubmit Hook that blocks with exit code 2 as a failed
        // `hook_response` right before the blocked notice; the Chat must show the block once.
        io.system('hook_response', {
            hook_name: 'UserPromptSubmit',
            hook_event: 'UserPromptSubmit',
            outcome: 'error',
            exit_code: 2,
            stderr: 'Example input blocked.\n',
            stdout: '',
            output: 'Example input blocked.\n',
        });
        io.system('informational', {
            level: 'warning',
            content: 'Prompt dropped by a hook.',
            prompt_submit_outcome: {
                kind: 'dropped_by_hook',
                reason: 'Example mod blocked this input.\nChoose another test input to continue.',
            },
        });
        io.send(
            io.frame({
                type: 'assistant',
                message: { content: [] },
                local_command_run: { command: 'display-test', args: '', plugin: 'output-test-mod' },
                local_command_source:
                    '<local-command-stdout>Example mod output.\nReview these details before continuing.</local-command-stdout>',
            }),
        );
        return;
    }
    const hasNotices = reply.includes('synthetic output');
    if (hasNotices) {
        io.system('informational', {
            content: 'Prompt dropped by a hook: Example prompt blocked for display test.',
            level: 'notice',
        });
    }
    if (hasNotices || reply.includes('synthetic routine hooks')) {
        io.system('hook_progress', {
            hook_id: 'example-hook',
            hook_name: 'Example',
            hook_event: 'UserPromptSubmit',
            stdout: 'Preparing example output.',
            stderr: '',
            output: '',
        });
        for (const stdout of [
            '{}',
            JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    permissionDecisionReason: 'Synthetic hook decision.',
                },
            }),
        ]) {
            io.system('hook_response', {
                hook_id: crypto.randomUUID(),
                hook_name: 'Example',
                hook_event: 'PreToolUse',
                stdout,
                stderr: '',
                output: stdout,
                outcome: 'success',
                exit_code: 0,
            });
        }
        io.system('synthetic_diagnostic', { content: 'Synthetic provider diagnostic.' });
    }
    const thinkingId = `msg_${crypto.randomUUID()}`;
    io.send(
        io.frame({
            type: 'stream_event',
            event: { type: 'message_start', message: { id: thinkingId } },
        }),
    );
    io.send(
        io.frame({
            type: 'stream_event',
            event: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' },
            },
        }),
    );
    io.send(
        io.frame({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Considering the request.' },
            },
        }),
    );
    io.assistant(thinkingId, {
        type: 'thinking',
        thinking: 'Considering the request.',
        signature: 'fake',
    });
    io.assistant(thinkingId, {
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID()}`,
        name: 'TodoWrite',
        input: {
            todos: [
                { content: 'Read the message', status: 'completed', activeForm: 'Reading' },
                { content: 'Reply', status: 'in_progress', activeForm: 'Replying' },
            ],
        },
    });
    await io.didStreamFully(`Hello from fake Claude. ${reply}`, 5);
    if (hasNotices) {
        io.system('hook_response', {
            hook_id: 'example-hook',
            hook_name: 'Example',
            hook_event: 'UserPromptSubmit',
            stdout: '{}',
            stderr: 'Example hook warning.',
            output: '',
            outcome: 'error',
            exit_code: 1,
        });
        io.system('local_command_output', { content: 'Example mod command output.' });
    }
}

/**
 * Three Claude in Chrome steps (open a page, click on it, and a find that fails) followed by a short reply, leaving the
 * turn's result to the caller.
 */
export async function streamBrowserSteps(io: FakeClaudeIo) {
    const messageId = `msg_${crypto.randomUUID()}`;
    const steps = [
        {
            name: 'mcp__claude-in-chrome__navigate',
            input: { url: 'https://example.test/settings', tabId: 1 },
            output: 'Navigated to https://example.test/settings',
        },
        {
            name: 'mcp__claude-in-chrome__computer',
            input: { action: 'left_click', ref: 'ref_12', tabId: 1 },
            output: 'Clicked ref_12',
        },
        {
            name: 'mcp__claude-in-chrome__find',
            input: { query: 'Export button', tabId: 1 },
            output: 'No matching element',
            isError: true,
        },
    ];
    for (const step of steps) {
        const id = `toolu_${crypto.randomUUID()}`;
        io.assistant(messageId, { type: 'tool_use', id, name: step.name, input: step.input });
        const message = {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: id,
                    content: step.output,
                    ...(step.isError && { is_error: true }),
                },
            ],
        };
        io.send(io.frame({ type: 'user', message }));
        io.record({ type: 'user', message });
    }
    await io.didStreamFully('Checked the settings page.', 0);
}

/**
 * The paced replies. `pause` streams a short reply slowly and `slow` a long one word by word; `think quietly` sends
 * nothing at all while `isHeld` (a `hold-reply` control file), as a turn spent in hidden reasoning does, then answers.
 * Returns whether the reply streamed to its end, or `undefined` when `text` asked for none; the caller ends the turn.
 */
export async function streamPacedReply(
    io: FakeClaudeIo,
    text: string,
    isHeld: () => boolean,
): Promise<{ isComplete: boolean } | undefined> {
    if (text.includes('pause'))
        return { isComplete: await io.didStreamFully('Thinking it over before answering.', 200) };
    if (text.includes('slow')) {
        const words = Array.from({ length: 400 }, (_, index) => `word${index} `).join('');
        return { isComplete: await io.didStreamFully(words, 25) };
    }
    if (!text.includes('think quietly')) return undefined;
    const waitWhileHeld = async (): Promise<void> => {
        if (!isHeld() || io.isInterrupted()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
        await waitWhileHeld();
    };
    await waitWhileHeld();
    return { isComplete: await io.didStreamFully('Done thinking.', 20) };
}
