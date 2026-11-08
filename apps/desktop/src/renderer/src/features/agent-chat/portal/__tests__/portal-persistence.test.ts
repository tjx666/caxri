import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSharedProfile } from '../../../../lib/__tests__/local-storage-profile';
import { forgetEnvironment, indexEnvironmentSnapshot } from '../../../../lib/environment-routing';
import {
    parsePortalEntries,
    persistPortalEntries,
    PORTAL_STORAGE_KEY,
    portalSessionDeletion,
    readPortalEntries,
    serializePortalEntry,
} from '../portal-persistence';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('portal persistence', () => {
    it('round-trips items, their order, the active item, and the owning machine per Session', () => {
        const entries = {
            s1: { items: { paths: ['a', 'b', 'c'], activePath: 'b' }, scope: 'local' },
            s2: { items: { paths: ['z'], activePath: 'z' }, scope: 'ssh:host-1' },
        };
        const stored = structuredClone({
            s1: serializePortalEntry(entries.s1),
            s2: serializePortalEntry(entries.s2),
        });
        expect(parsePortalEntries(stored)).toEqual(entries);
    });

    it('starts closed for a missing or malformed entry', () => {
        expect(parsePortalEntries(undefined)).toEqual({});
        expect(parsePortalEntries([])).toEqual({});
        expect(parsePortalEntries({ s: { paths: [] }, t: 4 })).toEqual({});
    });

    it('drops non-string and duplicate paths, repairs a stale active item, and defaults the scope', () => {
        expect(
            parsePortalEntries({ s: { paths: ['a', 7, 'a', 'b'], activePath: 'gone' } }),
        ).toEqual({
            s: { items: { paths: ['a', 'b'], activePath: 'a' }, scope: 'local' },
        });
    });

    it('keeps the Sessions of both windows when each saves its own', () => {
        installSharedProfile();
        // Two windows loaded an empty record, then each opened a Portal in a different Session.
        expect(readPortalEntries()).toEqual({});
        persistPortalEntries({ s1: { items: { paths: ['a'], activePath: 'a' }, scope: 'local' } });
        persistPortalEntries({
            s2: { items: { paths: ['b'], activePath: 'b' }, scope: 'ssh:host-1' },
        });
        expect(Object.keys(readPortalEntries())).toEqual(['s1', 's2']);
    });

    it('removes only the named Session', () => {
        installSharedProfile(
            new Map([
                [
                    PORTAL_STORAGE_KEY,
                    JSON.stringify({ s1: { paths: ['a'] }, s2: { paths: ['b'] } }),
                ],
            ]),
        );
        expect(Object.keys(persistPortalEntries({ s1: undefined }))).toEqual(['s2']);
    });

    it('drops the oldest Sessions past the bound', () => {
        installSharedProfile();
        for (let index = 0; index < 102; index += 1)
            persistPortalEntries({
                [`s${index}`]: { items: { paths: ['a'], activePath: 'a' }, scope: 'local' },
            });
        const kept = Object.keys(readPortalEntries());
        expect(kept).toHaveLength(100);
        expect(kept[0]).toBe('s2');
    });
});

function indexHost(environmentId: string, projectIds: string[], sessionIds: string[]): void {
    indexEnvironmentSnapshot(
        environmentId,
        {
            archivedTerminals: [],
            projects: projectIds.map((id) => ({ id })),
            sessions: sessionIds.map((id) => ({ id })),
            terminals: [],
        } as unknown as Parameters<typeof indexEnvironmentSnapshot>[1],
        0,
    );
}

describe('portalSessionDeletion', () => {
    it('treats a missing Session as deleted only on a machine the window lists', () => {
        indexHost('host-1', ['ssh-project'], ['ssh-live']);
        try {
            // This window lists host-1 (one live Session) and none of this Mac's Projects.
            const isDeleted = portalSessionDeletion({
                projects: [{ id: 'ssh-project' }],
                sessions: [{ id: 'ssh-live' }],
            });
            expect(isDeleted('ssh-live', 'ssh:host-1')).toBe(false);
            expect(isDeleted('ssh-gone', 'ssh:host-1')).toBe(true);
            // This Mac's Session is absent only because this window does not list this Mac.
            expect(isDeleted('local-session', 'local')).toBe(false);
            // Nor does it judge a third machine.
            expect(isDeleted('other', 'ssh:host-2')).toBe(false);
        } finally {
            forgetEnvironment('host-1');
        }
    });

    it('judges this Mac when the window lists one of its Projects', () => {
        const isDeleted = portalSessionDeletion({
            projects: [{ id: 'local-project' }],
            sessions: [{ id: 'local-live' }],
        });
        expect(isDeleted('local-live', 'local')).toBe(false);
        expect(isDeleted('local-gone', 'local')).toBe(true);
    });
});
