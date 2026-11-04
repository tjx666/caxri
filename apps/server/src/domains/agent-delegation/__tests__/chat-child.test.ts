import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import type { DelegationChatTurn } from '../chat-child';
import {
    assertChatChildAvailable,
    chatDelegationCompletion,
    delegationChildLaunch,
    resolveChildSurface,
} from '../chat-child';
import { readDelegationCompletion } from '../collection';
import { recoveredDelegation } from '../lifecycle';
import type { AgentDelegationServiceOptions } from '../service-options';

const POINTER =
    'Read the delegated task from "/data/d-1/task.md" and carry it out. Delegation ID: d-1.';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function record(
    provider: 'claude' | 'codex' | 'grok',
    fields: Partial<StoredAgentDelegation> = {},
): StoredAgentDelegation {
    return {
        receipt: { delegationId: 'd-1', provider, terminalId: 'terminal-1', status: 'running' },
        input: {},
        frozenLaunch: { executable: provider, args: ['--model', 'frozen'] },
        providerSessionId: provider === 'claude' ? 'session-1' : undefined,
        launchId: 'launch-1',
        turnId: 'turn-1',
        promptDigest: digest(POINTER),
        ...fields,
    } as StoredAgentDelegation;
}

const PREPARED = {
    launch: { executable: 'tui', args: ['--model', 'frozen', POINTER] },
    pointer: POINTER,
    initialPrompt: undefined,
    assignedAgentSessionId: 'session-1',
};

describe('delegationChildLaunch', () => {
    it('keeps the PTY launch while Chat is off', () => {
        const launch = delegationChildLaunch(
            { opensAgentsInChat: () => false, userDataPath: '/data' },
            record('claude'),
            PREPARED,
        );
        expect(launch).toEqual({
            launch: PREPARED.launch,
            initialPrompt: undefined,
            assignedAgentSessionId: 'session-1',
        });
    });

    it('keeps the PTY launch for a provider whose Chat cannot run a child', () => {
        const prepared = { ...PREPARED, initialPrompt: POINTER, assignedAgentSessionId: undefined };
        expect(
            delegationChildLaunch(
                { opensAgentsInChat: () => true, userDataPath: '/data' },
                record('grok'),
                prepared,
            ),
        ).not.toHaveProperty('surface');
    });

    it.each(['claude', 'codex'] as const)(
        'opens a %s child as a Chat with the pointer as its first message',
        (provider) => {
            const task = record(provider);
            const launch = delegationChildLaunch(
                { opensAgentsInChat: () => true, userDataPath: '/data' },
                task,
                PREPARED,
            );
            expect(launch).toMatchObject({
                surface: 'chat',
                initialPrompt: POINTER,
                assignedAgentSessionId: task.providerSessionId,
            });
            // The frozen launch without the pointer argv; Claude Code also reads the task directory.
            expect(launch.launch.args).not.toContain(POINTER);
            expect(launch.launch.args.slice(0, 2)).toEqual(['--model', 'frozen']);
        },
    );
});

describe('forced child surface', () => {
    type SurfaceOptions = Pick<AgentDelegationServiceOptions, 'hasAgentChat' | 'opensAgentsInChat'>;
    const on: SurfaceOptions = { hasAgentChat: () => true, opensAgentsInChat: () => true };
    const off: SurfaceOptions = { hasAgentChat: () => true, opensAgentsInChat: () => false };
    const noChat: SurfaceOptions = { hasAgentChat: () => false, opensAgentsInChat: () => false };

    it.each([
        ['setting on', on, undefined, 'chat'],
        ['setting off', off, undefined, 'pty'],
        ['setting on, forced pty', on, 'pty', 'pty'],
        ['setting off, forced chat', off, 'chat', 'chat'],
        ['setting on, forced chat', on, 'chat', 'chat'],
        ['setting off, forced pty', off, 'pty', 'pty'],
    ] as const)('resolves %s', (_label, options, requested, expected) => {
        expect(resolveChildSurface(options, 'claude', requested)).toBe(expected);
    });

    it('keeps a defaulted child on the PTY for a provider without Chat', () => {
        expect(resolveChildSurface(on, 'grok', undefined)).toBe('pty');
        expect(resolveChildSurface(on, 'grok', 'pty')).toBe('pty');
    });

    it.each([
        ['a provider whose Chat cannot carry the task', 'grok', on],
        ['an Agent without Chat support', 'antigravity', on],
        ['a Server without Agent Chat', 'claude', noChat],
    ] as const)(
        'refuses a forced Chat for %s instead of downgrading',
        (_label, provider, options) => {
            const attempt = () => resolveChildSurface(options, provider, 'chat');
            expect(attempt).toThrow(/Chat child is unavailable/u);
            expect(() => assertChatChildAvailable(options, provider)).toThrow(
                expect.objectContaining({ details: { reason: 'forced_chat_unavailable' } }),
            );
        },
    );

    it('launches a forced Terminal child on the PTY while the setting is on', () => {
        const launch = delegationChildLaunch(
            { ...on, userDataPath: '/data' },
            record('claude', {
                input: { surface: 'pty' },
                receipt: { ...record('claude').receipt, surface: 'pty' },
            } as Partial<StoredAgentDelegation>),
            PREPARED,
        );
        expect(launch).not.toHaveProperty('surface');
        expect(launch.launch).toBe(PREPARED.launch);
    });

    it('still requires lifecycle hooks for a forced Terminal child', () => {
        expect(() =>
            delegationChildLaunch(
                { ...on, hasLifecycleHooks: () => false, userDataPath: '/data' },
                record('claude', {
                    receipt: { ...record('claude').receipt, surface: 'pty' },
                }),
                PREPARED,
            ),
        ).toThrow(/lifecycle hooks/u);
    });

    it('launches a forced Chat child with the setting off and without hooks', () => {
        const launch = delegationChildLaunch(
            { ...off, hasLifecycleHooks: () => false, userDataPath: '/data' },
            record('codex', {
                receipt: { ...record('codex').receipt, surface: 'chat' },
            }),
            PREPARED,
        );
        expect(launch).toMatchObject({ surface: 'chat', initialPrompt: POINTER });
    });
});

describe('chatDelegationCompletion', () => {
    const answer = { id: 'item-1', text: 'Done.' };

    it.each([
        ['a running turn', { status: 'running' } as const, undefined],
        ['an unknown Chat', { status: 'unavailable' } as const, 'result_missing'],
        ['a missing turn', { status: 'missing' } as const, 'result_missing'],
        [
            'an interrupted turn',
            { status: 'finished', outcome: 'interrupted', answer, isTruncated: false } as const,
            'provider_failed',
        ],
        [
            'a turn without an answer',
            { status: 'finished', outcome: 'completed', isTruncated: false } as const,
            'result_missing',
        ],
        [
            'a truncated answer',
            { status: 'finished', outcome: 'completed', answer, isTruncated: true } as const,
            'payload_overflow',
        ],
    ])('settles %s', (_label, turn, failure) => {
        const completion = chatDelegationCompletion(record('codex'), turn);
        expect(completion).toEqual(failure && { kind: 'failed', failure });
    });

    it('accepts the answer only when it matches the digest Claude Code reported', () => {
        const turn = {
            status: 'finished',
            outcome: 'completed',
            answer,
            isTruncated: false,
        } as const;
        const matching = record('claude', { responseDigest: digest('Done.') });
        const other = record('claude', { responseDigest: digest('Other') });
        expect(chatDelegationCompletion(matching, turn)).toEqual({
            kind: 'answer',
            text: 'Done.',
            messageId: 'item-1',
        });
        expect(chatDelegationCompletion(other, turn)).toEqual({
            kind: 'failed',
            failure: 'correlation_missing',
        });
    });
});

describe('Chat child collection and recovery', () => {
    it('reads a Chat child from its projection instead of a transcript', async () => {
        const reader = {
            readTranscript: vi.fn<() => Promise<undefined>>(),
            readNativeTranscript: vi.fn<() => Promise<undefined>>(),
            readChatTurn: vi.fn<(terminalId: string, turnId: string) => DelegationChatTurn>(() => ({
                status: 'finished' as const,
                outcome: 'completed' as const,
                answer: { id: 'item-1', text: 'Done.' },
                isTruncated: false,
            })),
        };
        const result = await readDelegationCompletion(record('codex'), reader as never);
        expect(result.completion).toEqual({ kind: 'answer', text: 'Done.', messageId: 'item-1' });
        expect(reader.readChatTurn).toHaveBeenCalledWith('terminal-1', 'turn-1');
        expect(reader.readNativeTranscript).not.toHaveBeenCalled();
        expect(reader.readTranscript).not.toHaveBeenCalled();
    });

    it('cuts off a Chat child at a Server restart instead of collecting it', () => {
        const task = record('codex', { providerSessionId: 'thread-1' });
        expect(recoveredDelegation(task).shouldCollect).toBe(true);
        const recovered = recoveredDelegation(task, (terminalId) => terminalId === 'terminal-1');
        expect(recovered).toMatchObject({
            shouldCollect: false,
            next: { receipt: { status: 'interrupted', failure: 'host_reset' } },
        });
    });
});
