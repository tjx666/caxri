import { describe, expect, it } from 'vitest';

import {
    terminalFileLinkAmbiguousResolutionSchema,
    terminalFileLinkCandidateSchema,
} from '../terminal-file-link';

const candidate = {
    path: '/project/packages/service/index.ts',
    relativePath: 'packages/service/index.ts',
    projectId: 'project-1',
    projectTitle: 'Project',
};

describe('Terminal file-link candidate schemas', () => {
    it('accepts bounded authorized display metadata', () => {
        expect(terminalFileLinkCandidateSchema.parse(candidate)).toEqual(candidate);
        expect(
            terminalFileLinkAmbiguousResolutionSchema.safeParse({
                status: 'ambiguous',
                candidates: [candidate],
                sourceSessionId: 'session-1',
                truncated: false,
            }).success,
        ).toBe(true);
    });

    it('rejects an empty or oversized candidate result', () => {
        expect(
            terminalFileLinkAmbiguousResolutionSchema.safeParse({
                status: 'ambiguous',
                candidates: [],
                sourceSessionId: 'session-1',
                truncated: false,
            }).success,
        ).toBe(false);
        expect(
            terminalFileLinkAmbiguousResolutionSchema.safeParse({
                status: 'ambiguous',
                candidates: Array.from({ length: 51 }, () => candidate),
                sourceSessionId: 'session-1',
                truncated: true,
            }).success,
        ).toBe(false);
    });
});
