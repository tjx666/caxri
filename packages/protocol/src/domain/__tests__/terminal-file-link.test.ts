import { describe, expect, it } from 'vitest';

import {
    terminalFileLinkAmbiguousResolutionSchema,
    terminalFileLinkCandidateSchema,
    terminalFileLinkMethods,
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

describe('terminal.openFileLink result schema', () => {
    const resultSchema = terminalFileLinkMethods['terminal.openFileLink'].result;
    const document = {
        id: 'external-1',
        name: 'secret.json',
        displayPath: '/tmp/outside/secret.json',
        content: '{}',
        mtimeMs: 1,
        size: 2,
    };

    it('keeps the external document on an opened reply', () => {
        /**
         * Regression: the bare `{ opened: true }` union member used to come first and stripped `document`, so the
         * Renderer silently ignored an external open.
         */
        const reply = { opened: true as const, document, sessionId: 'session-1' };
        expect(resultSchema.parse(reply)).toEqual(reply);
        expect(resultSchema.parse({ opened: true })).toEqual({ opened: true });
    });
});
