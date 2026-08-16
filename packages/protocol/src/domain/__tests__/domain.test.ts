import { describe, expect, it } from 'vitest';

import {
    fileMutationOperationSchema,
    gitCommitPageSchema,
    gitPullRequestChangesSchema,
    identifierSchema,
    pathSchema,
    terminalKindSchema,
    themeTokensSchema,
    updateStateSchema,
} from '../domain.js';

describe('identifierSchema and pathSchema bounds', () => {
    it('rejects an empty identifier', () => {
        expect(identifierSchema.safeParse('').success).toBe(false);
    });

    it('rejects an identifier over the maximum length', () => {
        expect(identifierSchema.safeParse('a'.repeat(201)).success).toBe(false);
        expect(identifierSchema.safeParse('a'.repeat(200)).success).toBe(true);
    });

    it('rejects a path over the maximum length', () => {
        expect(pathSchema.safeParse('a'.repeat(16_385)).success).toBe(false);
        expect(pathSchema.safeParse('a'.repeat(16_384)).success).toBe(true);
    });
});

describe('terminalKindSchema', () => {
    it('accepts every Agent provider plus the bare shell kind', () => {
        expect(terminalKindSchema.safeParse('claude').success).toBe(true);
        expect(terminalKindSchema.safeParse('codex').success).toBe(true);
        expect(terminalKindSchema.safeParse('shell').success).toBe(true);
    });

    it('rejects an unregistered terminal kind', () => {
        expect(terminalKindSchema.safeParse('gemini').success).toBe(false);
    });
});

describe('themeTokensSchema hex color validation', () => {
    const validTheme = {
        id: 'theme-1',
        name: 'Theme',
        source: 'builtin' as const,
        colors: {
            background: '#000000',
            surface: '#000000',
            elevated: '#000000',
            foreground: '#ffffff',
            muted: '#000000',
            border: '#000000',
            selection: '#000000',
            accent: '#000000',
            success: '#000000',
            warning: '#000000',
            danger: '#000000',
        },
        terminal: {
            background: '#000000',
            foreground: '#ffffff',
            cursor: '#ffffff',
            selectionBackground: '#000000',
            black: '#000000',
            red: '#000000',
            green: '#000000',
            yellow: '#000000',
            blue: '#000000',
            magenta: '#000000',
            cyan: '#000000',
            white: '#ffffff',
            brightBlack: '#000000',
            brightRed: '#000000',
            brightGreen: '#000000',
            brightYellow: '#000000',
            brightBlue: '#000000',
            brightMagenta: '#000000',
            brightCyan: '#000000',
            brightWhite: '#ffffff',
        },
        editor: {
            background: '#000000',
            foreground: '#ffffff',
            lineHighlight: '#000000',
            selection: '#000000',
            comment: '#000000',
            keyword: '#000000',
            string: '#000000',
            number: '#000000',
        },
        warnings: [],
    };

    it('accepts a 6-digit and an 8-digit hex color with alpha', () => {
        expect(themeTokensSchema.safeParse(validTheme).success).toBe(true);
        expect(
            themeTokensSchema.safeParse({
                ...validTheme,
                colors: { ...validTheme.colors, accent: '#00000080' },
            }).success,
        ).toBe(true);
    });

    it('rejects a color that is not valid hex', () => {
        expect(
            themeTokensSchema.safeParse({
                ...validTheme,
                colors: { ...validTheme.colors, accent: 'not-a-color' },
            }).success,
        ).toBe(false);
    });

    it('rejects a hex color missing the leading hash', () => {
        expect(
            themeTokensSchema.safeParse({
                ...validTheme,
                colors: { ...validTheme.colors, accent: '000000' },
            }).success,
        ).toBe(false);
    });
});

describe('fileMutationOperationSchema discriminated union', () => {
    const base = {
        id: 'operation-1',
        sessionId: 'session-1',
        phase: 'staged' as const,
        startedAt: 1,
        updatedAt: 2,
    };

    it('requires create-specific input fields for the create kind', () => {
        expect(
            fileMutationOperationSchema.safeParse({
                ...base,
                kind: 'create',
                input: { directory: '/private/project', name: 'file.txt', kind: 'file' },
            }).success,
        ).toBe(true);
    });

    it('rejects a create operation carrying rename-only input fields', () => {
        expect(
            fileMutationOperationSchema.safeParse({
                ...base,
                kind: 'create',
                input: { path: '/private/project/file.txt', name: 'renamed.txt' },
            }).success,
        ).toBe(false);
    });

    it('requires conflict resolution for the move kind', () => {
        expect(
            fileMutationOperationSchema.safeParse({
                ...base,
                kind: 'move',
                input: {
                    path: '/private/project/file.txt',
                    directory: '/private/project/moved',
                },
            }).success,
        ).toBe(false);
        expect(
            fileMutationOperationSchema.safeParse({
                ...base,
                kind: 'move',
                input: {
                    path: '/private/project/file.txt',
                    directory: '/private/project/moved',
                    conflict: 'rename',
                },
            }).success,
        ).toBe(true);
    });

    it('rejects an unregistered mutation kind', () => {
        expect(
            fileMutationOperationSchema.safeParse({
                ...base,
                kind: 'delete',
                input: {},
            }).success,
        ).toBe(false);
    });
});

describe('updateStateSchema discriminated union', () => {
    it('requires action and message only on the error status', () => {
        expect(
            updateStateSchema.safeParse({ status: 'idle', currentVersion: '1.0.0' }).success,
        ).toBe(true);
        expect(
            updateStateSchema.safeParse({
                status: 'error',
                currentVersion: '1.0.0',
                action: 'check',
                message: 'network unavailable',
            }).success,
        ).toBe(true);
        expect(
            updateStateSchema.safeParse({ status: 'error', currentVersion: '1.0.0' }).success,
        ).toBe(false);
    });

    it('requires download progress fields only on the downloading status', () => {
        expect(
            updateStateSchema.safeParse({
                status: 'downloading',
                currentVersion: '1.0.0',
                version: '1.1.0',
                fileName: 'caxri.dmg',
                receivedBytes: 10,
            }).success,
        ).toBe(true);
        expect(
            updateStateSchema.safeParse({
                status: 'up-to-date',
                currentVersion: '1.0.0',
                receivedBytes: 10,
            }).success,
        ).toBe(true);
    });
});

describe('sha-based identity regexes', () => {
    it('requires a full 40-character lowercase hex sha for git commits', () => {
        const shortSha = '1'.repeat(39);
        const fullSha = '1'.repeat(40);
        const commit = {
            shortSha: fullSha.slice(0, 7),
            subject: 'Add feature',
            author: 'Author',
            authoredAt: 1,
            decorations: [],
            parents: [],
        };
        expect(
            gitCommitPageSchema.safeParse({ commits: [{ ...commit, sha: fullSha }] }).success,
        ).toBe(true);
        expect(
            gitCommitPageSchema.safeParse({ commits: [{ ...commit, sha: shortSha }] }).success,
        ).toBe(false);
    });

    it('requires matching sha shape for both baseOid and headOid on a Pull Request', () => {
        const sha = 'a'.repeat(40);
        expect(
            gitPullRequestChangesSchema.safeParse({
                repositoryId: 'repository-1',
                number: 1,
                title: 'Title',
                url: 'https://example.com/pr/1',
                baseRefName: 'main',
                headRefName: 'feature',
                baseOid: sha,
                headOid: 'not-a-sha',
                additions: 1,
                deletions: 0,
                files: [],
            }).success,
        ).toBe(false);
    });
});
