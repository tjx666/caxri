/**
 * The fake Grok ACP agent's tool calls that wait on the user: a shell command and a file edit behind
 * `session/request_permission`, and Grok Build's `_x.ai/ask_user_question`. Each emits the frames a live Grok Build
 * turn sends; `fake-grok-replay.ts` folds them into the shape its `session/load` replay sends.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

/**
 * The running turn's state, shared with the prompt loop that owns it.
 */
export interface PromptState {
    cancelled: boolean;
    interjections: string[];
}

/**
 * What a tool call needs from the fake agent's turn.
 */
export interface FakeGrokTurn {
    sessionId: string;
    prompt: PromptState;
    /**
     * Emits one conversation update and records it for replay.
     */
    update: (sessionUpdate: Record<string, unknown>) => void;
    /**
     * Sends a JSON-RPC request to the client and resolves with its result.
     */
    request: (method: string, parameters: Record<string, unknown>) => Promise<unknown>;
}

export function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function wasShellCallApproved(
    { sessionId, prompt, update, request }: FakeGrokTurn,
    command: string,
    isApprovalRequired: boolean,
): Promise<boolean> {
    const toolCallId = `call-${crypto.randomUUID()}`;
    const rawInput = { variant: 'Bash', command, description: `Run ${command}` };
    update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Bash',
        kind: 'other',
        status: 'pending',
        rawInput,
    });
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: `Execute \`${command}\``,
        kind: 'execute',
        rawInput,
        content: [{ type: 'content', content: { type: 'text', text: `Run ${command}` } }],
    });
    if (isApprovalRequired) {
        const result = (await request('session/request_permission', {
            sessionId,
            toolCall: { toolCallId, title: `Execute \`${command}\``, kind: 'execute', rawInput },
            options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
        })) as { outcome?: { outcome?: string; optionId?: string } };
        // A `cancelled` outcome stops the turn, whether or not `session/cancel` has arrived yet.
        if (result.outcome?.outcome === 'cancelled') prompt.cancelled = true;
        if (
            result.outcome?.optionId !== 'allow-once' &&
            result.outcome?.optionId !== 'always-allow'
        ) {
            update({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: 'failed',
                content: rejectedContent('run_terminal_command'),
            });
            return false;
        }
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: `${command}: ok` } }],
    });
    return true;
}

/**
 * The content Grok Build reports for a tool call the user rejected, live and again in its `session/load` replay, where
 * the call's status is `failed` like a call that broke. Verified against Grok Build 1.0.50 for `run_terminal_command`;
 * the file-edit tool's name is this fixture's stand-in.
 */
function rejectedContent(tool: string): unknown[] {
    return [
        {
            type: 'content',
            content: { type: 'text', text: `User rejected the execution for tool \`${tool}\`` },
        },
    ];
}

export async function wasPatchApproved({
    sessionId,
    update,
    request,
}: FakeGrokTurn): Promise<boolean> {
    const toolCallId = `call-${crypto.randomUUID()}`;
    const diff = {
        type: 'diff',
        path: path.join(process.cwd(), 'src', 'app.ts'),
        oldText: 'const value = 1;\n',
        newText: 'const value = 2;\n',
    };
    update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Edit',
        kind: 'other',
        status: 'pending',
        rawInput: {},
    });
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: 'Edit src/app.ts',
        kind: 'edit',
        content: [diff],
    });
    const result = (await request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId, kind: 'edit', content: [diff] },
        options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
    })) as { outcome?: { optionId?: string } };
    const isAccepted = result.outcome?.optionId === 'allow-once';
    update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: isAccepted ? 'completed' : 'failed',
        ...(!isAccepted && { content: rejectedContent('search_replace') }),
    });
    return isAccepted;
}

/**
 * Asks Grok Build's extension question and resolves with its answers, or `undefined` once the turn is cancelled: Grok
 * Build stops the turn on `session/cancel` and ignores a later answer.
 */
export async function askQuestions({
    sessionId,
    prompt,
    request,
}: FakeGrokTurn): Promise<Record<string, unknown> | undefined> {
    const answer = request('_x.ai/ask_user_question', {
        sessionId,
        toolCallId: `call-${crypto.randomUUID()}`,
        questions: [
            {
                question: 'Which color?',
                options: [
                    { label: 'Red', description: 'Warm' },
                    { label: 'Blue', description: 'Cool' },
                ],
                multiSelect: false,
            },
            {
                question: 'Which sizes?',
                options: [
                    { label: 'Small', description: '' },
                    { label: 'Large', description: '' },
                ],
                multiSelect: true,
            },
        ],
        mode: 'default',
    }) as Promise<{ outcome?: string; answers?: Record<string, unknown> }>;
    const cancelled = new Promise<undefined>((resolve) => {
        const timer = setInterval(() => {
            if (!prompt.cancelled) return;
            clearInterval(timer);
            resolve(undefined);
        }, 20);
        void answer.then(() => clearInterval(timer));
    });
    const result = await Promise.race([answer, cancelled]);
    if (!result) return undefined;
    if (result.outcome === 'accepted') return result.answers ?? {};
    // Caxri answers `cancelled` just before `session/cancel` when the user stops the turn.
    await delay(50);
    return prompt.cancelled ? undefined : {};
}
