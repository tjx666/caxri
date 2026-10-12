import type { ProjectRecord, SessionContentSearchResult, SessionRecord } from '@caxri/protocol';

import type { Translate } from '../../../i18n';

/**
 * Joins matches with current Session metadata. `project` is undefined when the Project is gone; the dialog renders the
 * localized fallback so this helper stays free of display copy.
 */
export function contentSearchItems(
    result: SessionContentSearchResult | undefined,
    sessions: ReadonlyArray<
        Pick<SessionRecord, 'id' | 'displayTitle' | 'projectId' | 'archivedAt'>
    >,
    projects: ReadonlyArray<Pick<ProjectRecord, 'id' | 'displayTitle'>>,
) {
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    return (result?.matches ?? []).flatMap((match) => {
        const session = sessionById.get(match.sessionId);
        if (!session) return [];
        return [
            {
                ...match,
                title: session.displayTitle,
                project: projectById.get(session.projectId)?.displayTitle,
                isArchived: session.archivedAt !== undefined,
            },
        ];
    });
}

export function contentSearchCoverage(result: SessionContentSearchResult, t: Translate): string {
    const coverage = t('session.contentSearch.coverage', {
        scanned: result.scanned,
        total: result.total,
    });
    if (!result.partial) return coverage;
    const unavailable =
        result.unavailable > 0
            ? t('session.contentSearch.unavailable', { count: result.unavailable })
            : '';
    const limit =
        result.reason === 'budget'
            ? t('session.contentSearch.budgetLimit')
            : result.reason === 'results'
              ? t('session.contentSearch.resultLimit')
              : result.unavailable === 0
                ? t('session.contentSearch.skipped')
                : '';
    return t('session.contentSearch.partial', { coverage: `${coverage}${unavailable}${limit}` });
}
