/**
 * The fake `agy acp`'s `ask_question` tool: questions sent as an ACP form elicitation, in the shape `agy` 1.5.16 sends.
 */
import crypto from 'node:crypto';

/**
 * What the question tool needs from the fake agent's turn.
 */
export interface FakeAntigravityTurn {
    sessionId: string | undefined;
    /**
     * Whether `initialize` advertised `elicitation.form`; like `agy` 1.5.16, the fake asks no question without it.
     */
    canElicit: boolean;
    /**
     * Emits one conversation update and records it for replay.
     */
    update: (sessionUpdate: Record<string, unknown>) => void;
    /**
     * Sends a JSON-RPC request to the client and resolves with its result.
     */
    request: (method: string, parameters: Record<string, unknown>) => Promise<unknown>;
}

const OTHER = { type: 'string', title: 'Other', description: 'Optional free-form answer' };

/**
 * A single-choice and a multi-select question as one form elicitation, each with a free-text `_other` property and the
 * recommended choice titled `(Recommended) ...`. Without the client's `elicitation.form` capability the tool call stays
 * `pending` and the turn ends unanswered. Returns the reply naming the form's answer.
 */
export async function askQuestions({
    sessionId,
    canElicit,
    update,
    request,
}: FakeAntigravityTurn): Promise<string> {
    const toolCallId = `call_${crypto.randomUUID()}`;
    update({
        sessionUpdate: 'tool_call',
        toolCallId,
        name: 'ask_question',
        title: 'Run ask_question',
        kind: 'other',
        status: 'in_progress',
        rawInput: { questions: [{ question: 'Which color?', options: ['Red', 'Blue'] }] },
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'pending' });
    if (!canElicit) return 'Nobody answered.';
    const result = (await request('elicitation/create', {
        sessionId,
        toolCallId,
        mode: 'form',
        message: 'The agent has 2 questions.',
        requestedSchema: {
            type: 'object',
            properties: {
                q1: {
                    type: 'string',
                    title: 'Which color?',
                    oneOf: [
                        { const: '1', title: '(Recommended) Red' },
                        { const: '2', title: 'Blue' },
                    ],
                },
                q1_other: OTHER,
                q2: {
                    type: 'array',
                    title: 'Which fruits?',
                    items: {
                        anyOf: [
                            { const: '1', title: 'Apple' },
                            { const: '2', title: 'Pear' },
                        ],
                    },
                },
                q2_other: OTHER,
            },
        },
    })) as { action?: string; content?: unknown };
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
    return result.action === 'accept'
        ? `Answers: ${JSON.stringify(result.content)}`
        : `Answers: ${result.action ?? 'none'}`;
}
