import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { searchSessionReferenceCandidates } from '@caxri/protocol';

/**
 * One row of the `@` Sessions group: a Session whose Agent conversation can be cited.
 */
export interface SessionReferenceCandidate {
    projectTitle: string | undefined;
    sessionId: string;
    title: string;
}

/**
 * The Sessions an `@` can cite, searched by title (`searchSessionReferenceCandidates`), with their Project titles.
 */
export function searchSessionReferences(
    sessions: readonly SessionRecord[] | undefined,
    projects: readonly ProjectRecord[] | undefined,
    currentSessionId: string | undefined,
    query: string,
): SessionReferenceCandidate[] {
    const projectTitles = new Map(projects?.map((project) => [project.id, project.title]));
    return searchSessionReferenceCandidates(sessions, currentSessionId, query).map((session) => ({
        projectTitle: projectTitles.get(session.projectId),
        sessionId: session.id,
        title: session.title,
    }));
}

/**
 * The Project of each Session this window cited, by its reference file, so a Session chip's tooltip can name it. The
 * reference text carries only the title; a chip restored after a restart names only that.
 */
const citedProjects = new Map<string, string>();

export function rememberSessionReferenceProject(
    path: string,
    projectTitle: string | undefined,
): void {
    if (projectTitle) citedProjects.set(path, projectTitle);
}

/**
 * The Project of the Session whose reference file is `path`, when this window cited it.
 */
export function sessionReferenceProjectTitle(path: string): string | undefined {
    return citedProjects.get(path);
}

/**
 * The Session title being searched when a picker's query starts with `@`, the same prefix that cites a Session in the
 * Chat composer; `undefined` for any other query.
 */
export function sessionReferenceQuery(search: string): string | undefined {
    const trimmed = search.trimStart();
    return trimmed.startsWith('@') ? trimmed.slice(1) : undefined;
}
