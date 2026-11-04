import { createHash } from 'node:crypto';

import type { AgentChatItem, AgentDelegationTranscript } from '@caxri/protocol';
import {
    delegatedRedirectMessage,
    MAX_DELEGATION_TRANSCRIPT_ROW_TEXT,
    MAX_DELEGATION_TRANSCRIPT_ROWS,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import type { DelegationTranscriptSnapshot } from '../transcript';
import { readDelegationChatPage } from '../transcript';

const TEXT = 'Switch to the synthetic fixture approach';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function record(
    redirects: StoredAgentDelegation['redirects'],
    status: 'running' | 'completed' = 'running',
): StoredAgentDelegation {
    return {
        receipt: {
            delegationId: 'task-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            provider: 'claude',
            status,
            terminalId: 'terminal-1',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
        },
        principal: { kind: 'human-cli', id: 'synthetic-owner' },
        input: {
            projectId: 'project-1',
            sessionId: 'session-1',
            provider: 'claude',
            prompt: 'Synthetic task',
        },
        fingerprint: 'synthetic-fingerprint',
        promptDigest: 'a'.repeat(64),
        frozenLaunch: { executable: 'claude', args: [] },
        ...(redirects && { redirects }),
    } satisfies StoredAgentDelegation;
}

const delivered = (operationId = 'op-1', text = TEXT) => ({
    operationId,
    digest: digest(text),
    state: 'delivered' as const,
    at: 1,
});
const start: AgentChatItem = {
    id: 'start',
    type: 'userMessage',
    text: 'Read the task in a private file.',
    delegatedTask: { delegationId: 'task-1' },
};
const redirectItem = (
    id: string,
    options: { operationId?: string; delegationId?: string; text?: string; isAwaiting?: true } = {},
): AgentChatItem => ({
    id,
    type: 'userMessage',
    text: delegatedRedirectMessage(
        options.delegationId ?? 'task-1',
        options.operationId ?? 'op-1',
        options.text ?? TEXT,
    ),
    delivery: 'steered',
    ...(options.isAwaiting && { isAwaitingAgent: true as const }),
});
const reply = (id: string, text: string): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text,
    streaming: false,
});
const human = (id: string): AgentChatItem => ({
    id,
    type: 'userMessage',
    text: 'Typed by the user',
});

function read(
    items: AgentChatItem[],
    task: StoredAgentDelegation,
    after?: string,
): Extract<AgentDelegationTranscript, { status: 'available' }> {
    const snapshot: DelegationTranscriptSnapshot = { historyId: 'history-1', items };
    const result = readDelegationChatPage(
        {
            readChildChat: () => true,
            isChatTerminal: () => true,
            snapshot: () => snapshot,
        },
        task,
        after,
    );
    if (result.status !== 'available') throw new Error(`unavailable: ${result.reason}`);
    return result;
}

describe('transcript with a redirect', () => {
    it("continues past this task's confirmed redirect and shows it as a direction row", () => {
        const page = read(
            [
                start,
                reply('before', 'Working on it'),
                redirectItem('direction'),
                reply('after', 'Switching approach'),
            ],
            record([delivered()]),
        );

        expect(page.rows.map((row) => [row.id, row.kind])).toEqual([
            ['start', 'task'],
            ['before', 'agentMessage'],
            ['direction', 'direction'],
            ['after', 'agentMessage'],
        ]);
        expect(page.rows[2]).toEqual({ id: 'direction', kind: 'direction', text: TEXT });
    });

    it.each([
        ['an operation the task never recorded', [] as StoredAgentDelegation['redirects']],
        ['a claim for different text', [delivered('op-1', 'Some other direction')]],
    ])('still ends at %s', (_label, redirects) => {
        const page = read(
            [
                start,
                reply('before', 'Working on it'),
                redirectItem('direction'),
                reply('after', 'x'),
            ],
            record(redirects),
        );

        expect(page.rows.map((row) => row.id)).toEqual(['start', 'before']);
    });

    it.each(['pending', 'unknown'] as const)(
        'shows a %s redirect that sits in the conversation so the reader can learn it arrived',
        (state) => {
            const page = read(
                [start, redirectItem('direction'), reply('after', 'Switching')],
                record([{ ...delivered(), state }]),
            );

            expect(page.rows.map((row) => row.kind)).toEqual(['task', 'direction', 'agentMessage']);
        },
    );

    it('still ends at a redirect of another task and at what a person typed', () => {
        const task = record([delivered()]);

        expect(
            read([start, redirectItem('other', { delegationId: 'task-2' }), reply('x', 'y')], task)
                .rows.length,
        ).toBe(1);
        expect(
            read([start, reply('a', 'b'), human('typed'), reply('x', 'y')], task).rows.length,
        ).toBe(2);
        expect(
            read(
                [start, redirectItem('direction'), human('typed'), reply('x', 'y')],
                task,
            ).rows.map((row) => row.id),
        ).toEqual(['start', 'direction']);
    });

    it('does not cross a redirect Claude Code still holds, so no cursor can pass a message that may move', () => {
        const task = record([delivered()]);
        const awaiting = redirectItem('direction', { isAwaiting: true });

        const held = read([start, reply('before', 'Working'), awaiting], task);
        expect(held.rows.map((row) => row.id)).toEqual(['start', 'before']);
        const cursor = held.next;
        expect(cursor).toBeDefined();

        const taken = read(
            [
                start,
                reply('before', 'Working'),
                reply('streamed', 'More'),
                redirectItem('direction'),
            ],
            task,
            cursor,
        );
        expect(taken.rows.map((row) => row.id)).toEqual(['streamed', 'direction']);
    });

    it('keeps an earlier cursor valid once a redirect joins the slice', () => {
        const task = record([delivered()]);
        const first = read([start, reply('before', 'Working')], task);

        const later = read(
            [start, reply('before', 'Working'), redirectItem('direction'), reply('after', 'Done')],
            task,
            first.next,
        );

        expect(later.rows.map((row) => row.kind)).toEqual(['direction', 'agentMessage']);
    });

    it('counts a direction row in the page budget and clips its text', () => {
        const long = 'x'.repeat(MAX_DELEGATION_TRANSCRIPT_ROW_TEXT + 10);
        const page = read(
            [start, redirectItem('direction', { text: long })],
            record([delivered('op-1', long)]),
        );

        const row = page.rows[1];
        expect(row).toMatchObject({ kind: 'direction', truncated: true });
        expect((row as { text: string }).text).toHaveLength(MAX_DELEGATION_TRANSCRIPT_ROW_TEXT);
        expect(MAX_DELEGATION_TRANSCRIPT_ROWS).toBeGreaterThan(2);
    });

    it('reports a settled task with its redirect as settled', () => {
        const page = read(
            [start, redirectItem('direction'), reply('after', 'Done')],
            record([delivered()], 'completed'),
        );

        expect(page.settled).toBe(true);
        expect(page.rows).toHaveLength(3);
    });
});
