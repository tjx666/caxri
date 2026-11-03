import type { BootstrapState } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
    environmentOfSession,
    forgetEnvironment,
    indexEnvironmentSnapshot,
    indexReplyRecords,
    resolveRequestEnvironment,
    routingGeneration,
    sessionsByEnvironment,
    trackRemoteRequest,
} from './environment-routing';

const HOST = 'me@build-box:22';

function snapshot(): Pick<
    BootstrapState,
    'archivedTerminals' | 'projects' | 'sessions' | 'terminals'
> {
    return {
        projects: [{ id: 'remote-project' }],
        sessions: [{ id: 'remote-session' }],
        terminals: [{ id: 'remote-terminal' }],
        archivedTerminals: [{ id: 'archived-terminal' }],
    } as unknown as Pick<
        BootstrapState,
        'archivedTerminals' | 'projects' | 'sessions' | 'terminals'
    >;
}

afterEach(() => forgetEnvironment(HOST));

describe('resolveRequestEnvironment', () => {
    it('sends a request about an SSH Host record to that Host and anything else to this Mac', () => {
        indexEnvironmentSnapshot(HOST, snapshot(), routingGeneration());
        expect(resolveRequestEnvironment('session.select', { sessionId: 'remote-session' })).toBe(
            HOST,
        );
        expect(
            resolveRequestEnvironment('terminal.write', { terminalId: 'archived-terminal' }),
        ).toBe(HOST);
        expect(resolveRequestEnvironment('project.rename', { projectId: 'remote-project' })).toBe(
            HOST,
        );
        expect(
            resolveRequestEnvironment('session.archive', { sessionIds: ['remote-session'] }),
        ).toBe(HOST);
        expect(
            resolveRequestEnvironment('session.select', { sessionId: 'local-session' }),
        ).toBeUndefined();
        expect(resolveRequestEnvironment('settings.update', { key: 'x' })).toBeUndefined();
        expect(resolveRequestEnvironment('app.bootstrap', undefined)).toBeUndefined();
    });

    it('lets the Session decide a request that also names a Project on another machine', () => {
        indexEnvironmentSnapshot(HOST, snapshot(), routingGeneration());
        expect(
            resolveRequestEnvironment('session.move', {
                projectId: 'local-project',
                sessionId: 'remote-session',
            }),
        ).toBe(HOST);
    });

    it('cancels a request on the Host running it until it settles', () => {
        const untrack = trackRemoteRequest('request-1', HOST);
        expect(resolveRequestEnvironment('requests.cancel', { requestId: 'request-1' })).toBe(HOST);
        untrack();
        expect(
            resolveRequestEnvironment('requests.cancel', { requestId: 'request-1' }),
        ).toBeUndefined();
    });

    it('forgets a disconnected Host and replaces its records on a new snapshot', () => {
        indexEnvironmentSnapshot(HOST, snapshot(), routingGeneration());
        indexEnvironmentSnapshot(HOST, { ...snapshot(), sessions: [] }, routingGeneration());
        expect(environmentOfSession('remote-session')).toBeUndefined();
        indexEnvironmentSnapshot(HOST, snapshot(), routingGeneration());
        forgetEnvironment(HOST);
        expect(
            resolveRequestEnvironment('project.rename', { projectId: 'remote-project' }),
        ).toBeUndefined();
    });
});

describe('indexReplyRecords', () => {
    it('routes a record an SSH Host just created before any snapshot lists it', () => {
        indexReplyRecords(HOST, { id: 'new-project', rootPath: '/srv/app' });
        indexReplyRecords(HOST, {
            session: { id: 'new-session', projectId: 'new-project' },
            terminal: { id: 'new-terminal', sessionId: 'new-session' },
        });
        expect(resolveRequestEnvironment('session.create', { projectId: 'new-project' })).toBe(
            HOST,
        );
        expect(environmentOfSession('new-session')).toBe(HOST);
        expect(resolveRequestEnvironment('terminal.write', { terminalId: 'new-terminal' })).toBe(
            HOST,
        );
        indexReplyRecords(HOST, null);
        indexReplyRecords(HOST, { ok: true });
    });

    it('keeps a record created during a snapshot read that predates it, until a later snapshot', () => {
        const readAt = routingGeneration();
        indexReplyRecords(HOST, { session: { id: 'new-session', projectId: 'remote-project' } });
        indexEnvironmentSnapshot(HOST, snapshot(), readAt);
        expect(environmentOfSession('new-session')).toBe(HOST);
        indexEnvironmentSnapshot(HOST, snapshot(), routingGeneration());
        expect(environmentOfSession('new-session')).toBeUndefined();
    });
});

describe('sessionsByEnvironment', () => {
    it('splits a mixed batch into one group per machine in first-seen order', () => {
        indexEnvironmentSnapshot(
            HOST,
            { ...snapshot(), sessions: [{ id: 'r1' }, { id: 'r2' }] as never },
            routingGeneration(),
        );
        expect(sessionsByEnvironment(['l1', 'r1', 'l2', 'r2'])).toEqual([
            [undefined, ['l1', 'l2']],
            [HOST, ['r1', 'r2']],
        ]);
    });
});
