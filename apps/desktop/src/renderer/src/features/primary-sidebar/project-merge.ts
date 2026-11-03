/* eslint-disable unicorn/name-replacements -- Repository is the domain term the `project.repositoryKeys` method uses. */
import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import { topLevelProjects } from './project-visibility';

/**
 * One side bar Project heading: a single Project, or a repository checked out on several machines.
 */
export interface MergedProject {
    /**
     * The heading's identity for collapse, keyboard, and order: the lead's Project id.
     */
    id: string;
    /**
     * The first member in side bar order; the heading shows its title and icon.
     */
    lead: ProjectRecord;
    /**
     * Every Project under the heading, the lead first, in side bar order.
     */
    members: readonly ProjectRecord[];
}

/**
 * Groups the Projects that are checkouts of the same repository on different machines under one heading, as T3 Code,
 * Paseo, and Superset do. A Project without a repository key stays alone, and so does every Project of a repository
 * that one machine holds more than one checkout of: merging those would hide which checkout a Session belongs to on
 * that machine, where nothing else tells them apart.
 *
 * @param projects Every top-level Project, in side bar order.
 * @param repositoryKeyOf A Project's repository key; `null` or `undefined` (not read yet) never merges.
 * @param machineOf The machine a Project lives on: `undefined` for this Mac.
 */
export function mergeProjectsByRepository(
    projects: readonly ProjectRecord[],
    repositoryKeyOf: (projectId: string) => string | null | undefined,
    machineOf: (projectId: string) => string | undefined,
): MergedProject[] {
    const byKey = new Map<string, ProjectRecord[]>();
    for (const project of projects) {
        const key = repositoryKeyOf(project.id);
        if (!key) continue;
        const members = byKey.get(key);
        if (members) members.push(project);
        else byKey.set(key, [project]);
    }
    const leadOf = new Map<string, ProjectRecord[]>();
    for (const members of byKey.values()) {
        const machines = new Set(members.map((member) => machineOf(member.id)));
        if (members.length > 1 && machines.size === members.length)
            for (const member of members) leadOf.set(member.id, members);
    }
    const merged: MergedProject[] = [];
    for (const project of projects) {
        const members = leadOf.get(project.id);
        if (!members) merged.push({ id: project.id, lead: project, members: [project] });
        else if (members[0] === project) merged.push({ id: project.id, lead: project, members });
    }
    return merged;
}

/**
 * The heading each Project sits under, by Project id.
 */
export function mergedProjectIdByMember(
    merged: readonly MergedProject[],
): ReadonlyMap<string, string> {
    const ids = new Map<string, string>();
    for (const entry of merged) for (const member of entry.members) ids.set(member.id, entry.id);
    return ids;
}

/**
 * Re-points every Session group id at the heading that shows it: a delegated Session's host group, else its own
 * Project, through the merged heading that Project sits under. The collapse record and the reveal path key on it.
 */
export function mergedGroupIdBySessionId(
    groupIdBySessionId: ReadonlyMap<string, string>,
    sessions: ReadonlyArray<{ id: string; projectId: string }>,
    headingOf: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
    const ids = new Map<string, string>();
    for (const session of sessions) {
        const groupId = groupIdBySessionId.get(session.id) ?? session.projectId;
        const heading = headingOf.get(groupId) ?? groupId;
        if (heading !== session.projectId || groupIdBySessionId.has(session.id))
            ids.set(session.id, heading);
    }
    return ids;
}

/**
 * Every Project a change to `projectId` should reach: the members of the merged heading it sits under, else itself.
 * Merges the side bar's top-level Projects, as the side bar does, so a same-machine worktree Project never splits a
 * heading here that the side bar shows merged.
 */
export function mergedPeerIds(
    projects: readonly ProjectRecord[],
    projectId: string,
    repoKeyOf: (projectId: string) => string | null | undefined,
    machineOf: (projectId: string) => string | undefined,
): string[] {
    const entry = mergeProjectsByRepository(topLevelProjects(projects), repoKeyOf, machineOf).find(
        (candidate) => candidate.members.some((member) => member.id === projectId),
    );
    return entry ? entry.members.map((member) => member.id) : [projectId];
}

/**
 * The Project a Session row under a heading acts on: its own machine's checkout, which for a merged heading is not
 * always the heading's `project`.
 */
export function sessionMemberLookup(
    project: ProjectRecord,
    members: readonly ProjectRecord[],
): (session: SessionRecord) => ProjectRecord {
    const memberById = new Map(members.map((member) => [member.id, member]));
    return (session) => memberById.get(session.projectId) ?? project;
}

/* eslint-enable unicorn/name-replacements */
