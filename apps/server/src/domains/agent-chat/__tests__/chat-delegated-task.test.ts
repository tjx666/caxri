import { createHash } from 'node:crypto';

import type { AgentChatPatchOperation } from '@caxri/protocol';
import {
    delegatedRedirectMessage,
    delegatedTaskPointer,
    parseDelegatedTaskPointer,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { delegatedTaskDetails, stampDelegatedTasks } from '../chat-delegated-task';

const DELEGATION_ID = 'dispatch-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const pointer = delegatedTaskPointer(
    `/tmp/profile/delegations/${DELEGATION_ID}/task.md`,
    DELEGATION_ID,
);

function database(
    callerSessionId: string | undefined,
    botSessionId = 'bot-session',
    isHandoff = false,
) {
    const input = { prompt: 'Fix the flaky login test', ...(isHandoff && { handoff: true }) };
    return {
        agentDelegations: {
            get: (id: string) =>
                id === DELEGATION_ID
                    ? { receipt: { callerTerminalId: 'caller-terminal' }, input }
                    : undefined,
        },
        getTerminal: (id: string) =>
            id === 'caller-terminal' && callerSessionId
                ? { sessionId: callerSessionId }
                : undefined,
        caxriBotRows: () => ({ sessionId: botSessionId }),
    } as unknown as Parameters<typeof delegatedTaskDetails>[0];
}

describe('delegated task pointer', () => {
    it('round-trips the pointer the delegation launch writes', () => {
        expect(parseDelegatedTaskPointer(pointer)).toEqual({
            taskPath: `/tmp/profile/delegations/${DELEGATION_ID}/task.md`,
            delegationId: DELEGATION_ID,
        });
        expect(parseDelegatedTaskPointer('Read the delegated task from somewhere')).toBeUndefined();
    });
});

describe('delegatedTaskDetails', () => {
    it('names the calling Session, or Caxri Bot for its hidden Session, with the task it asked', () => {
        const prompt = 'Fix the flaky login test';
        expect(delegatedTaskDetails(database('session-a'), DELEGATION_ID)).toEqual({
            prompt,
            source: { kind: 'session', sessionId: 'session-a' },
        });
        expect(delegatedTaskDetails(database('bot-session'), DELEGATION_ID)).toEqual({
            prompt,
            source: { kind: 'bot' },
        });
        expect(delegatedTaskDetails(database(undefined), DELEGATION_ID)).toEqual({ prompt });
        expect(delegatedTaskDetails(database('session-a'), 'gone')).toEqual({});
    });

    it('marks a task its Session handed off with /new-session', () => {
        expect(
            delegatedTaskDetails(database('session-a', 'bot-session', true), DELEGATION_ID),
        ).toEqual({
            prompt: 'Fix the flaky login test',
            source: { kind: 'session', sessionId: 'session-a' },
            handoff: true,
        });
    });
});

describe('stampDelegatedTasks', () => {
    it('marks only user messages that are delegated task pointers', () => {
        const operations: AgentChatPatchOperation[] = [
            { op: 'upsertItem', item: { id: 'a', type: 'userMessage', text: pointer } },
            { op: 'upsertItem', item: { id: 'b', type: 'userMessage', text: 'hello' } },
        ];
        const stamped = stampDelegatedTasks(operations, () => ({
            prompt: 'Fix it',
            source: { kind: 'bot' },
        }));
        expect(stamped[0]).toMatchObject({
            item: {
                delegatedTask: {
                    delegationId: DELEGATION_ID,
                    prompt: 'Fix it',
                    source: { kind: 'bot' },
                },
            },
        });
        expect(stamped[1]).toBe(operations[1]);
        expect(stampDelegatedTasks([operations[1]], () => ({}))).toEqual([operations[1]]);
    });

    it('keeps the pointer recognizable when the record is gone', () => {
        const [operation] = stampDelegatedTasks(
            [{ op: 'upsertItem', item: { id: 'a', type: 'userMessage', text: pointer } }],
            () => ({}),
        );
        expect(operation).toMatchObject({
            item: { delegatedTask: { delegationId: DELEGATION_ID } },
        });
        expect(operation).not.toHaveProperty('item.delegatedTask.source');
    });
});

describe('delegated redirect', () => {
    const text = 'Use the synthetic fixtures';
    const forgedDigest = 'f'.repeat(64);
    const digest = createHash('sha256').update(text).digest('hex');
    const withClaims = (redirects: Array<{ operationId: string; digest: string }>) =>
        ({
            agentDelegations: {
                get: () => ({
                    receipt: { callerTerminalId: 'caller-terminal' },
                    input: { prompt: 'Fix the flaky login test' },
                    redirects,
                }),
            },
            getTerminal: () => ({ sessionId: 'session-a' }),
            caxriBotRows: () => ({ sessionId: 'bot-session' }),
        }) as unknown as Parameters<typeof delegatedTaskDetails>[0];

    it('shows the direction as the message only when the task recorded this operation with this text', () => {
        const redirect = { operationId: 'op-12345', text };

        expect(
            delegatedTaskDetails(
                withClaims([{ operationId: 'op-12345', digest }]),
                DELEGATION_ID,
                redirect,
            ),
        ).toEqual({
            prompt: text,
            source: { kind: 'session', sessionId: 'session-a' },
            redirect: true,
        });
        expect(delegatedTaskDetails(withClaims([]), DELEGATION_ID, redirect)).toEqual({});
        expect(
            delegatedTaskDetails(
                withClaims([{ operationId: 'op-12345', digest: forgedDigest }]),
                DELEGATION_ID,
                redirect,
            ),
        ).toEqual({});
    });

    it('stamps a redirect envelope with the redirect flag', () => {
        const message = delegatedRedirectMessage(DELEGATION_ID, 'op-12345', text);
        const operations: AgentChatPatchOperation[] = [
            { op: 'upsertItem', item: { id: 'a', type: 'userMessage', text: message } },
        ];
        const stamped = stampDelegatedTasks(operations, (_id, redirect) =>
            redirect ? { prompt: redirect.text, redirect: true } : {},
        );

        expect(stamped[0]).toMatchObject({
            item: { delegatedTask: { delegationId: DELEGATION_ID, prompt: text, redirect: true } },
        });
    });
});
