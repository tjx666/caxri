import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSharedProfile } from '../../../lib/__tests__/local-storage-profile';
import type { ProjectCollapseState } from '../project-collapse';
import {
    createProjectCollapsePersistence,
    PROJECT_COLLAPSE_STORAGE_KEY,
    projectCollapseChanges,
} from '../project-collapse-persistence';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('projectCollapseChanges', () => {
    it('lists only the Projects whose disclosure changed', () => {
        expect(
            projectCollapseChanges(
                { a: 'user-collapsed', b: 'user-collapsed' },
                { a: 'user-collapsed', b: 'user-expanded', c: 'automatic' },
                new Set(['a', 'b', 'c']),
            ),
        ).toEqual({ b: 'user-expanded', c: 'automatic' });
    });

    it('removes a record only for a Project this window lists', () => {
        const persisted: ProjectCollapseState = { here: 'automatic', elsewhere: 'user-collapsed' };
        expect(projectCollapseChanges(persisted, {}, new Set(['here']))).toEqual({
            here: undefined,
        });
        // Still loading: nothing is known, so nothing is removed.
        expect(projectCollapseChanges(persisted, {}, undefined)).toEqual({});
    });
});

describe('createProjectCollapsePersistence', () => {
    it('keeps a collapse made in each of two windows across a restart', () => {
        installSharedProfile();
        const windowA = createProjectCollapsePersistence();
        const windowB = createProjectCollapsePersistence();
        const known = new Set(['projectA', 'projectB']);

        windowA.persist({ projectA: 'user-collapsed' }, known);
        // Window B started before A wrote, so its view lacks Project A; it collapses Project B.
        windowB.persist({ projectB: 'user-collapsed' }, known);

        expect(createProjectCollapsePersistence().initial()).toEqual({
            projectA: 'user-collapsed',
            projectB: 'user-collapsed',
        });
    });

    it('follows the other window without writing its change back', () => {
        const profile = installSharedProfile();
        const windowA = createProjectCollapsePersistence();
        const windowB = createProjectCollapsePersistence();
        const known = new Set(['projectA']);
        let seenByB: ProjectCollapseState = {};
        windowB.subscribe((state) => {
            seenByB = state;
        });

        windowA.persist({ projectA: 'user-collapsed' }, known);
        profile.fireStorageEvent(PROJECT_COLLAPSE_STORAGE_KEY);
        expect(seenByB).toEqual({ projectA: 'user-collapsed' });

        // B's reconciliation of the delivered state equals what is stored, so persisting it is a no-op.
        const before = profile.entries.get(PROJECT_COLLAPSE_STORAGE_KEY);
        const setItem = vi.spyOn(localStorage, 'setItem');
        windowB.persist(seenByB, known);
        expect(setItem).not.toHaveBeenCalled();
        expect(profile.entries.get(PROJECT_COLLAPSE_STORAGE_KEY)).toBe(before);
    });

    it('does not rewrite an unchanged record on mount', () => {
        installSharedProfile(
            new Map([[PROJECT_COLLAPSE_STORAGE_KEY, '{"projectA":"user-collapsed"}']]),
        );
        const persistence = createProjectCollapsePersistence();
        const setItem = vi.spyOn(localStorage, 'setItem');
        persistence.persist(persistence.initial(), new Set(['projectA']));
        expect(setItem).not.toHaveBeenCalled();
    });
});
