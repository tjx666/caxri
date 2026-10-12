import type { SessionContentSearchResult } from '@caxri/protocol';
import { expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    contentSearchCoverage as describeCoverage,
    contentSearchItems,
} from '../content-search-model';

const contentSearchCoverage = (value: SessionContentSearchResult) =>
    describeCoverage(value, translate);

const result: SessionContentSearchResult = {
    matches: [
        { sessionId: 'one', provider: 'claude', snippet: 'matched text' },
        { sessionId: 'removed', provider: 'codex', snippet: 'gone' },
    ],
    scanned: 2,
    total: 3,
    unavailable: 1,
    partial: true,
    reason: 'coverage',
};

it('joins current Session metadata and drops deleted results without restoring archives', () => {
    expect(
        contentSearchItems(
            result,
            [{ id: 'one', displayTitle: 'Archived work', projectId: 'project', archivedAt: 1 }],
            [{ id: 'project', displayTitle: 'Project A' }],
        ),
    ).toEqual([
        {
            sessionId: 'one',
            provider: 'claude',
            snippet: 'matched text',
            title: 'Archived work',
            project: 'Project A',
            isArchived: true,
        },
    ]);
});

it('makes incomplete coverage and result limits explicit', () => {
    expect(contentSearchCoverage(result)).toContain('Partial results');
    expect(contentSearchCoverage({ ...result, unavailable: 0 })).toContain('content was skipped');
    expect(contentSearchCoverage(result)).toContain('2 of 3');
    expect(contentSearchCoverage(result)).toContain('1 without readable');
    expect(contentSearchCoverage({ ...result, reason: 'results' })).toContain('narrow your query');
    expect(contentSearchCoverage({ ...result, partial: false, unavailable: 0 })).not.toContain(
        'Partial',
    );
});
