import { describe, expect, it } from 'vitest';

import { MAX_FILE_BROWSE_ENTRIES } from '../../domain/file-contract';
import { internalMethods, methods } from '../methods';

describe('noParameters default', () => {
    it('lets a caller omit params entirely on a no-argument method', () => {
        expect(methods['app.bootstrap'].params.parse(undefined)).toEqual({});
        expect(methods['app.bootstrap'].params.parse({})).toEqual({});
    });
});

describe('project.create selected root identity', () => {
    const schema = methods['project.create'].params;

    it('accepts a numeric filesystem identity and rejects malformed identifiers', () => {
        const rootPath = '/private/project';
        expect(
            schema.safeParse({
                rootPath,
                expectedRootIdentity: { path: rootPath, device: '1', inode: '10' },
            }).success,
        ).toBe(true);
        expect(
            schema.safeParse({
                rootPath,
                expectedRootIdentity: { path: rootPath, device: 'replaced', inode: '10' },
            }).success,
        ).toBe(false);
    });
});

describe('files.create name refinement', () => {
    const schema = methods['files.create'].params;
    const base = { operationId: 'op-1', sessionId: 'session-1', directory: '/private/project' };

    it('accepts a plain file name and defaults kind to file', () => {
        const parsed = schema.parse({ ...base, name: 'notes.txt' });
        expect(parsed).toMatchObject({ name: 'notes.txt', kind: 'file' });
    });

    it('rejects dot, dot-dot, and path-separator-bearing names', () => {
        expect(schema.safeParse({ ...base, name: '.' }).success).toBe(false);
        expect(schema.safeParse({ ...base, name: '..' }).success).toBe(false);
        expect(schema.safeParse({ ...base, name: 'a/b' }).success).toBe(false);
        expect(schema.safeParse({ ...base, name: String.raw`a\b` }).success).toBe(false);
        expect(schema.safeParse({ ...base, name: `a${String.fromCodePoint(0)}b` }).success).toBe(
            false,
        );
    });

    it('rejects an empty or whitespace-only name after trimming', () => {
        expect(schema.safeParse({ ...base, name: ' '.repeat(3) }).success).toBe(false);
    });
});

describe('terminal.attach dimension pairing refinement', () => {
    const schema = methods['terminal.attach'].params;

    it('accepts both dimensions provided together or both omitted', () => {
        expect(schema.safeParse({ terminalId: 'terminal-1' }).success).toBe(true);
        expect(schema.safeParse({ terminalId: 'terminal-1', cols: 80, rows: 24 }).success).toBe(
            true,
        );
    });

    it('rejects a lone cols or rows value', () => {
        expect(schema.safeParse({ terminalId: 'terminal-1', cols: 80 }).success).toBe(false);
        expect(schema.safeParse({ terminalId: 'terminal-1', rows: 24 }).success).toBe(false);
    });
});

describe('external.open result shape', () => {
    const schema = methods['external.open'].result;

    it('accepts opened, canceled, and a bounded set of rejection reasons', () => {
        expect(schema.safeParse({ status: 'opened' }).success).toBe(true);
        expect(schema.safeParse({ status: 'canceled' }).success).toBe(true);
        expect(
            schema.safeParse({ status: 'rejected', reason: 'credentials_not_allowed' }).success,
        ).toBe(true);
    });

    it('rejects a rejected status without a recognized reason', () => {
        expect(schema.safeParse({ status: 'rejected', reason: 'because' }).success).toBe(false);
        expect(schema.safeParse({ status: 'rejected' }).success).toBe(false);
    });
});

describe('files.browse bound', () => {
    it('exports the same cap enforced on the browse result entries array', () => {
        expect(MAX_FILE_BROWSE_ENTRIES).toBe(200);
        const tooMany = Array.from({ length: MAX_FILE_BROWSE_ENTRIES + 1 }, (_unused, index) => ({
            name: `entry-${index}`,
            path: `/private/entry-${index}`,
            kind: 'file',
        }));
        expect(
            methods['files.browse'].result.safeParse({ entries: tooMany, truncated: true }).success,
        ).toBe(false);
    });
});

describe('Files Core recovery scope and list bound', () => {
    it('requires a Session scope for every durable operation lookup and control', () => {
        for (const method of [
            'files.operation.get',
            'files.operation.list',
            'files.operation.cancel',
            'files.operation.acknowledge',
        ] as const) {
            const parameters =
                method === 'files.operation.list'
                    ? { sessionId: 'session-1' }
                    : { operationId: 'operation-1', sessionId: 'session-1' };
            expect(methods[method].params.safeParse(parameters).success).toBe(true);
            expect(
                methods[method].params.safeParse(
                    method === 'files.operation.list' ? {} : { operationId: 'operation-1' },
                ).success,
            ).toBe(false);
        }
    });

    it('returns an explicit bounded directory page instead of an unbounded array', () => {
        expect(
            methods['files.list'].result.safeParse({ entries: [], truncated: false }).success,
        ).toBe(true);
        expect(methods['files.list'].result.safeParse([]).success).toBe(false);
    });
});

describe('git.commitDetails sha shape', () => {
    it('requires a full lowercase 40-character sha', () => {
        const schema = methods['git.commitDetails'].params;
        const base = { sessionId: 'session-1', repositoryId: 'repository-1' };
        expect(schema.safeParse({ ...base, sha: 'a'.repeat(40) }).success).toBe(true);
        expect(schema.safeParse({ ...base, sha: 'A'.repeat(40) }).success).toBe(false);
        expect(schema.safeParse({ ...base, sha: 'a'.repeat(39) }).success).toBe(false);
        expect(schema.safeParse({ ...base, sha: `${'a'.repeat(39)}Z` }).success).toBe(false);
    });
});

describe('git.fileHead result bounds', () => {
    const schema = methods['git.fileHead'].result;
    const result = {
        sha: 'a'.repeat(40),
        shortSha: 'a'.repeat(7),
        subject: 'change file',
        body: '',
        author: 'Caxri Test',
        authorEmail: 'test@example.com',
        authoredAt: 1,
        decorations: [],
        parents: [],
        repositoryId: 'repository-1',
        path: 'src/app.ts',
    };

    it('bounds the returned repository identity and repository-relative path', () => {
        expect(schema.safeParse(result).success).toBe(true);
        expect(schema.safeParse({ ...result, repositoryId: 'r'.repeat(201) }).success).toBe(false);
        expect(schema.safeParse({ ...result, path: 'p'.repeat(16_385) }).success).toBe(false);
    });
});

describe('Runtime-owned Git discard consent', () => {
    it('accepts only extension intent and rejects Runtime-derived prompt metadata', () => {
        const schema = methods['git.discard'].params;
        const base = { sessionId: 'session-1', repositoryId: 'repository-1' };
        expect(schema.safeParse({ ...base, scope: { kind: 'all' } }).success).toBe(true);
        expect(
            schema.safeParse({
                ...base,
                repositoryName: 'spoofed-name',
                scope: { kind: 'all', fileCount: 999 },
            }).success,
        ).toBe(false);
        expect(
            schema.safeParse({
                ...base,
                scope: { kind: 'file', path: 'tracked.txt', untracked: true },
            }).success,
        ).toBe(false);
    });

    it('accepts only a repository/scope lookup for preflight, never prompt metadata', () => {
        const schema = internalMethods['git.discard.preflight'].params;
        expect(
            schema.safeParse({
                sessionId: 'session-1',
                repositoryId: 'repository-1',
                scope: { kind: 'file', path: 'tracked.txt' },
            }).success,
        ).toBe(true);
        expect(
            schema.safeParse({
                sessionId: 'session-1',
                repositoryId: 'repository-1',
                scope: { kind: 'all', fileCount: 999 },
            }).success,
        ).toBe(false);
    });

    it('requires an opaque token for the destructive apply step', () => {
        const schema = internalMethods['git.discard.apply'].params;
        expect(schema.safeParse({ token: 'discard-token' }).success).toBe(true);
        expect(schema.safeParse({ token: '' }).success).toBe(false);
    });
});

describe('files.authorizeTrash internal identity fields', () => {
    it('requires numeric-string device and inode identifiers for the entry and its root', () => {
        const schema = internalMethods['files.authorizeTrash'].result;
        const base = {
            name: 'notes.txt',
            path: '/private/project/notes.txt',
            kind: 'file',
        };
        expect(
            schema.safeParse({
                ...base,
                device: '1',
                inode: '2',
                root: { path: '/private/project', device: '1', inode: '3' },
            }).success,
        ).toBe(true);
        expect(
            schema.safeParse({
                ...base,
                device: 'not-numeric',
                inode: '2',
                root: { path: '/private/project', device: '1', inode: '3' },
            }).success,
        ).toBe(false);
    });
});

describe('host.stop default confirmation', () => {
    it('defaults confirmLivePtys to false when params are omitted', () => {
        expect(methods['host.stop'].params.parse(undefined)).toEqual({ confirmLivePtys: false });
    });
});

describe('controlled view operation scope', () => {
    it('requires a typed Session or no-Session context on every provider request', () => {
        const schema = methods['viewContainers.viewOperation'].params;
        const request = {
            viewId: 'publisher.git.sourceControl',
            requestId: 'request-1',
            operation: 'source.snapshot' as const,
            arguments: { refresh: 0 },
        };

        expect(
            schema.safeParse({
                ...request,
                context: {
                    kind: 'session',
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-1',
                },
            }).success,
        ).toBe(true);
        expect(schema.safeParse(request).success).toBe(false);
        expect(
            schema.safeParse({
                ...request,
                context: { kind: 'session', sessionId: 'session-1' },
            }).success,
        ).toBe(false);
    });

    it('bounds the active resource on Source Control snapshots', () => {
        const schema = methods['viewContainers.viewOperation'].params;
        const request = {
            viewId: 'publisher.git.sourceControl',
            requestId: 'request-1',
            context: {
                kind: 'session' as const,
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
            },
            operation: 'source.snapshot' as const,
            arguments: { refresh: 0 },
        };

        expect(
            schema.safeParse({
                ...request,
                arguments: { ...request.arguments, activeResource: '/private/project/README.md' },
            }).success,
        ).toBe(true);
        for (const activeResource of ['', 'x'.repeat(8_193)])
            expect(
                schema.safeParse({
                    ...request,
                    arguments: { ...request.arguments, activeResource },
                }).success,
            ).toBe(false);
    });

    it('allows history pages to request action-activated items explicitly', () => {
        const schema = methods['viewContainers.viewOperation'].params;
        const request = {
            viewId: 'publisher.git.sourceControl',
            requestId: 'request-1',
            context: {
                kind: 'session' as const,
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
            },
            operation: 'source.historyPage' as const,
            arguments: {
                historyId: 'repo-1',
                itemActivation: 'action',
                offset: 0,
                pageSize: 5,
                path: 'src/file.ts',
                revision: '1',
            },
        };

        expect(schema.safeParse(request).success).toBe(true);
        expect(
            schema.safeParse({
                ...request,
                arguments: { ...request.arguments, itemActivation: 'details' },
            }).success,
        ).toBe(false);
    });
});
