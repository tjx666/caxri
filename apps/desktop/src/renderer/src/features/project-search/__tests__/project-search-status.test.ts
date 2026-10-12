import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    projectSearchDisplayState,
    projectSearchTerminationMessage,
} from '../project-search-status';

describe('projectSearchDisplayState', () => {
    it('does not treat an incomplete empty search as no results', () => {
        expect(
            projectSearchDisplayState({
                active: true,
                settled: true,
                fetching: false,
                failed: false,
                matchCount: 0,
                truncated: true,
                canceled: false,
            }),
        ).toBe('incomplete');
    });

    it('shows a definitive empty state only after a complete search', () => {
        expect(
            projectSearchDisplayState({
                active: true,
                settled: true,
                fetching: false,
                failed: false,
                matchCount: 0,
                truncated: false,
                canceled: false,
            }),
        ).toBe('empty');
    });

    it('does not treat a canceled empty search as no results', () => {
        expect(
            projectSearchDisplayState({
                active: true,
                settled: true,
                fetching: false,
                failed: false,
                matchCount: 0,
                truncated: false,
                canceled: true,
            }),
        ).toBe('incomplete');
    });

    it('keeps partial matches visible when a search reaches a bound', () => {
        expect(
            projectSearchDisplayState({
                active: true,
                settled: true,
                fetching: false,
                failed: false,
                matchCount: 1,
                truncated: true,
                canceled: false,
            }),
        ).toBe('results');
    });
});

describe('projectSearchTerminationMessage', () => {
    it('explains why an empty result is incomplete', () => {
        expect(projectSearchTerminationMessage(translate, 'timeout', 8_087, false)).toBe(
            'Search timed out after scanning 8,087 files. Narrow the search to try again.',
        );
    });

    it('labels bounded matches as partial results', () => {
        expect(projectSearchTerminationMessage(translate, 'result-limit', 42, true)).toBe(
            'Search reached the result limit. Showing partial results.',
        );
    });
});
