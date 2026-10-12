/**
 * Approval scenarios for the fake Claude Code CLI (`fake-claude-cli.ts`): tools that ask for permission through the
 * `can_use_tool` control request (`approve`, `edit`, `planmode`, `ask`). Kept apart so the CLI stand-in stays
 * readable.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import type { FakeClaudeIo } from './fake-claude-io.ts';

type Json = Record<string, unknown>;

/**
 * The plan `planmode` asks to approve. Eight steps run past the phone's six-line approval clamp, so the mobile card has
 * to offer Show all.
 */
export const FAKE_CLAUDE_PLAN = [
    '1. Read the notes.',
    '2. List the open questions.',
    '3. Group them by topic.',
    '4. Draft one paragraph per topic.',
    '5. Check each claim against the notes.',
    '6. Trim the repeated points.',
    '7. Summarize them in one paragraph.',
    '8. Save the summary beside the notes.',
].join('\n');

async function wasToolAllowed(
    io: FakeClaudeIo,
    name: string,
    input: Json,
    run: (input: Json) => { content: string; structured?: Json },
    onAllowed?: (decision: Json) => void,
): Promise<boolean> {
    const toolUseId = `toolu_${crypto.randomUUID()}`;
    io.assistant(`msg_${crypto.randomUUID()}`, { type: 'tool_use', id: toolUseId, name, input });
    const decision = await io.controlRequest({
        subtype: 'can_use_tool',
        tool_name: name,
        input,
        tool_use_id: toolUseId,
        permission_suggestions: [
            {
                type: 'addRules',
                rules: [{ toolName: name }],
                behavior: 'allow',
                destination: 'session',
            },
        ],
        decision_reason: `Fake ${name} approval`,
    });
    const isAllowed = decision.behavior === 'allow';
    if (isAllowed) onAllowed?.(decision);
    const updatedInput = (decision.updatedInput as Json | undefined) ?? input;
    const result = isAllowed
        ? run(updatedInput)
        : { content: typeof decision.message === 'string' ? decision.message : 'Denied' };
    const block = {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result.content,
        ...(!isAllowed && { is_error: true }),
    };
    const message = { role: 'user', content: [block] };
    io.send(
        io.frame({
            type: 'user',
            message,
            ...(result.structured && { tool_use_result: result.structured }),
        }),
    );
    io.record({
        type: 'user',
        message,
        ...(result.structured && { toolUseResult: result.structured }),
    });
    if (decision.interrupt === true) io.markInterrupted();
    return isAllowed;
}

/**
 * Runs the approval scenario `text` selects, and returns whether one matched.
 */
export async function didRunApprovalScenario(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
): Promise<boolean> {
    if (text.includes('approve')) {
        const isAllowed = await wasToolAllowed(
            io,
            'Bash',
            { command: 'echo approved', description: 'Print a confirmation' },
            () => ({ content: 'approved' }),
        );
        if (!io.isInterrupted())
            await io.didStreamFully(isAllowed ? 'The command ran.' : 'Skipped the command.', 0);
        io.result(startedAt, 'done');
        return true;
    }
    if (text.includes('edit')) {
        const filePath = path.join(process.cwd(), 'notes.txt');
        const isAllowed = await wasToolAllowed(
            io,
            'Edit',
            { file_path: filePath, old_string: 'old line', new_string: 'new line' },
            () => ({
                content: 'The file has been updated.',
                structured: {
                    filePath,
                    structuredPatch: [
                        {
                            oldStart: 3,
                            oldLines: 1,
                            newStart: 3,
                            newLines: 1,
                            lines: ['-old line', '+new line'],
                        },
                    ],
                },
            }),
        );
        if (!io.isInterrupted())
            await io.didStreamFully(isAllowed ? 'Edited notes.txt.' : 'Left notes.txt alone.', 0);
        io.result(startedAt, 'done');
        return true;
    }
    if (text.includes('planmode')) {
        const isAllowed = await wasToolAllowed(
            io,
            'ExitPlanMode',
            { plan: FAKE_CLAUDE_PLAN },
            () => ({ content: 'User has approved your plan.' }),
            (decision) => {
                io.exitPlanMode(approvedMode(decision));
            },
        );
        if (!io.isInterrupted())
            await io.didStreamFully(isAllowed ? 'Plan approved.' : 'Kept planning.', 0);
        io.result(startedAt, 'done');
        return true;
    }
    if (text.includes('ask recommended')) {
        let chosen = 'nothing';
        await wasToolAllowed(
            io,
            'AskUserQuestion',
            {
                questions: [
                    {
                        header: 'Scope',
                        question: 'How much should the fix cover?',
                        multiSelect: false,
                        options: [
                            {
                                label: 'Only the reported case (Recommended)',
                                description: 'Smallest change; ships today',
                            },
                            { label: 'Every similar surface', description: 'Broader audit first' },
                        ],
                    },
                    {
                        header: 'Tests',
                        question: 'Add a regression test?',
                        multiSelect: false,
                        options: [
                            { label: 'Yes', description: 'Unit test beside the fix' },
                            { label: 'No', description: 'Rely on existing coverage' },
                        ],
                    },
                ],
            },
            (input) => {
                const answers = (input.answers as Record<string, string> | undefined) ?? {};
                chosen = Object.values(answers).join(' + ') || 'nothing';
                return { content: `User has answered your questions: ${chosen}.` };
            },
        );
        if (!io.isInterrupted()) await io.didStreamFully(`You chose ${chosen}.`, 0);
        io.result(startedAt, 'done');
        return true;
    }
    if (text.includes('ask')) {
        let answer = 'nothing';
        await wasToolAllowed(
            io,
            'AskUserQuestion',
            {
                questions: [
                    {
                        header: 'Color',
                        question: 'Which color?',
                        multiSelect: false,
                        options: [
                            { label: 'Blue', description: 'Calm' },
                            { label: 'Red', description: 'Bold' },
                        ],
                    },
                ],
            },
            (input) => {
                const answers = (input.answers as Record<string, string> | undefined) ?? {};
                answer = answers['Which color?'] ?? 'nothing';
                return { content: `User has answered your questions: "Which color?"="${answer}".` };
            },
        );
        if (!io.isInterrupted()) await io.didStreamFully(`You chose ${answer}.`, 0);
        io.result(startedAt, 'done');
        return true;
    }
    return false;
}

/**
 * The mode a `setMode` update in an approval switches to, as Claude Code applies it with the approval.
 */
function approvedMode(decision: Json): string | undefined {
    const updates = Array.isArray(decision.updatedPermissions) ? decision.updatedPermissions : [];
    for (const update of updates as Json[])
        if (update.type === 'setMode' && typeof update.mode === 'string') return update.mode;
    return undefined;
}
