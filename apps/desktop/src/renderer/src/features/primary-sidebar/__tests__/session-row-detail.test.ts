import { describe, expect, it } from 'vitest';

import { sessionRowDetail } from '../session-row-detail';

describe('sessionRowDetail', () => {
    it('shows the Project once in the Pinned group when the suffix already names it', () => {
        expect(sessionRowDetail('proj-a · #4', 'proj-a', true)).toEqual({
            showProjectName: false,
            suffix: 'proj-a · #4',
        });
        expect(sessionRowDetail('proj-a', 'proj-a', true)).toEqual({
            showProjectName: false,
            suffix: 'proj-a',
        });
    });

    it('keeps the trailing Project name in the Pinned group when the suffix does not carry it', () => {
        expect(sessionRowDetail('#2', 'proj-a', true)).toEqual({
            showProjectName: true,
            suffix: '#2',
        });
        expect(sessionRowDetail(undefined, 'proj-a', true)).toEqual({
            showProjectName: true,
            suffix: undefined,
        });
    });

    it('strips the group own Project from ordinary rows', () => {
        expect(sessionRowDetail('proj-a · #4', 'proj-a', false)).toEqual({
            showProjectName: false,
            suffix: '#4',
        });
        expect(sessionRowDetail('proj-a', 'proj-a', false)).toEqual({
            showProjectName: false,
            suffix: undefined,
        });
        expect(sessionRowDetail('Claude Code', 'proj-a', false).suffix).toBe('Claude Code');
    });
});
