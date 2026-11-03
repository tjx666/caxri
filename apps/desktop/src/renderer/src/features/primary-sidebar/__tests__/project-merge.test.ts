import type { ProjectRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    mergedGroupIdBySessionId,
    mergedPeerIds,
    mergedProjectIdByMember,
    mergeProjectsByRepository as mergeProjectsByRepo,
} from '../project-merge';

function project(id: string): ProjectRecord {
    return { id, title: id, rootPath: `/work/${id}` } as unknown as ProjectRecord;
}

const machines: Record<string, string | undefined> = {
    local: undefined,
    localTwin: undefined,
    remote: 'host-a',
    other: 'host-b',
};
const machineOf = (id: string) => machines[id];

describe('mergeProjectsByRepository', () => {
    it('puts one repository checked out on several machines under the first one in side bar order', () => {
        const keys: Record<string, string> = { remote: 'repo', local: 'repo', other: 'repo' };
        const merged = mergeProjectsByRepo(
            [project('remote'), project('local'), project('other')],
            (id) => keys[id],
            machineOf,
        );
        expect(merged).toHaveLength(1);
        expect(merged[0]?.id).toBe('remote');
        expect(merged[0]?.members.map((member) => member.id)).toEqual(['remote', 'local', 'other']);
    });

    it('keeps every checkout apart when one machine holds two of the same repository', () => {
        const keys: Record<string, string> = { local: 'repo', localTwin: 'repo', remote: 'repo' };
        const merged = mergeProjectsByRepo(
            [project('local'), project('localTwin'), project('remote')],
            (id) => keys[id],
            machineOf,
        );
        expect(merged.map((entry) => entry.members.length)).toEqual([1, 1, 1]);
    });

    it('never merges a Project whose repository is unknown or absent', () => {
        const keys: Record<string, string | null> = { local: null };
        const merged = mergeProjectsByRepo(
            [project('local'), project('remote')],
            (id) => keys[id],
            machineOf,
        );
        expect(merged.map((entry) => entry.id)).toEqual(['local', 'remote']);
    });
});

describe('merged heading lookups', () => {
    const merged = mergeProjectsByRepo(
        [project('local'), project('remote')],
        () => 'repo',
        machineOf,
    );

    it('maps every member to its heading', () => {
        expect([...mergedProjectIdByMember(merged)]).toEqual([
            ['local', 'local'],
            ['remote', 'local'],
        ]);
    });

    it('re-points a member Session and a delegated Session at the heading that shows them', () => {
        const ids = mergedGroupIdBySessionId(
            new Map([['delegated', 'remote']]),
            [
                { id: 'own', projectId: 'local' },
                { id: 'member', projectId: 'remote' },
                { id: 'delegated', projectId: 'elsewhere' },
            ],
            mergedProjectIdByMember(merged),
        );
        expect([...ids]).toEqual([
            ['member', 'local'],
            ['delegated', 'local'],
        ]);
    });
});

describe('mergedPeerIds', () => {
    it("reaches every machine's checkout, ignoring a worktree Project the side bar does not list", () => {
        const keys: Record<string, string> = { local: 'repo', worktree: 'repo', remote: 'repo' };
        const worktree = { ...project('worktree'), ownerProjectId: 'local' } as ProjectRecord;
        const projects = [project('local'), worktree, project('remote')];
        expect(mergedPeerIds(projects, 'remote', (id) => keys[id], machineOf)).toEqual([
            'local',
            'remote',
        ]);
        expect(mergedPeerIds(projects, 'other', (id) => keys[id], machineOf)).toEqual(['other']);
    });
});
