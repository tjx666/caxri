import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSessionSendHandler } from '../agent-session-send';
import type { CaxriDatabase } from '../db';

const principal = {
    kind: 'agent' as const,
    id: 'agent',
    endpointId: 'agent',
    generation: 1,
    projectIds: ['project-a'],
};

interface Fixture {
    archived?: boolean;
    hidden?: boolean;
    launchId?: string | null;
    submit?: 'accepted' | 'rejected' | 'unknown';
    targetSurface?: 'chat' | 'pty' | 'none';
}

function fixture({
    archived = false,
    hidden = false,
    launchId = 'launch-1',
    submit = 'accepted',
    targetSurface = 'chat',
}: Fixture = {}) {
    const terminals: Record<string, TerminalRecord> = {
        caller: { id: 'caller', sessionId: 'source', provider: 'claude' } as TerminalRecord,
        target: {
            id: 'target',
            sessionId: 'target-session',
            provider: targetSurface === 'none' ? undefined : 'codex',
            surface: targetSurface === 'chat' ? 'chat' : 'pty',
        } as TerminalRecord,
    };
    const sessions: Record<string, SessionRecord> = {
        'source': {
            id: 'source',
            projectId: 'project-a',
            title: 'Fix sign-in',
        } as SessionRecord,
        'target-session': {
            id: 'target-session',
            projectId: 'project-b',
            primaryAgentTerminalId: 'target',
            ...(archived && { archivedAt: 1 }),
        } as SessionRecord,
    };
    const projects = [
        { id: 'project-a' } as ProjectRecord,
        ...(hidden ? [] : [{ id: 'project-b' } as ProjectRecord]),
    ];
    const send = vi.fn(() => Promise.resolve());
    const submitAgentExact = vi.fn(() => Promise.resolve(submit));
    const handlers = createAgentSessionSendHandler({
        agentChat: { send },
        database: {
            getTerminal: (id: string) => terminals[id],
            getSession: (id: string) => sessions[id],
            listVisibleProjects: () => projects,
        } as unknown as CaxriDatabase,
        terminals: { agentLaunchId: () => launchId ?? undefined, submitAgentExact },
    });
    const relay = (sessionId = 'target-session', text = 'Drop the dependency pin') =>
        handlers['agent.session.sendInternal']({
            principal,
            callerTerminalId: 'caller',
            sessionId,
            text,
        });
    return { relay, send, submitAgentExact };
}

const relayed = `[Caxri] Relayed from Session "Fix sign-in" at the user's request:\n\nDrop the dependency pin`;

describe('agent.session.sendInternal', () => {
    it("delivers into another Session's Chat through the composer's Enter path, labeled with its source", async () => {
        const { relay, send } = fixture();

        await expect(relay()).resolves.toEqual({
            sessionId: 'target-session',
            terminalId: 'target',
            delivery: 'chat',
        });
        // `steer` is what Enter sends: an idle Chat starts a turn, a running one takes it after its tool call.
        expect(send).toHaveBeenCalledWith('target', { text: relayed }, 'steer', 'delegation');
    });

    it("submits to a Terminal Agent pinned to the Agent's current launch", async () => {
        const { relay, submitAgentExact } = fixture({ targetSurface: 'pty' });

        await expect(relay()).resolves.toMatchObject({ delivery: 'terminal' });
        expect(submitAgentExact).toHaveBeenCalledWith(
            'target',
            'target-session',
            'launch-1',
            relayed,
            undefined,
            'delegation',
        );
    });

    it.each([
        ['the caller own Session', { sessionId: 'source' }, 'VALIDATION'],
        ['an unknown Session', { sessionId: 'missing' }, 'NOT_FOUND'],
        ['an archived Session', { archived: true }, 'NOT_FOUND'],
        ['a Session in a hidden Project', { hidden: true }, 'NOT_FOUND'],
        ['a Session without an Agent', { targetSurface: 'none' as const }, 'CONFLICT'],
        [
            'a stopped Terminal Agent',
            { targetSurface: 'pty' as const, launchId: null },
            'UNAVAILABLE',
        ],
        [
            'an unconfirmed Terminal submit',
            { targetSurface: 'pty' as const, submit: 'unknown' as const },
            'UNAVAILABLE',
        ],
    ])('refuses %s', async (_name, options: Fixture & { sessionId?: string }, code) => {
        const { relay, send } = fixture(options);

        await expect(relay(options.sessionId)).rejects.toMatchObject({ code });
        expect(send).not.toHaveBeenCalled();
    });
});
