import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog }));

import type { PathBrowserOpenTarget } from '../path-browser-authority';
import { createPathBrowserAuthority } from '../path-browser-authority';
import type { DesktopServerConnection } from '../server-connection';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(path);
    return path;
}

afterEach(async () => {
    electronMock.dialog.showOpenDialog.mockReset();
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

function server(request: (method: string, parameters?: unknown) => Promise<unknown>) {
    return { request } as unknown as DesktopServerConnection;
}

function bootstrap(ownerRoot: string, workbenchRoot: string) {
    return {
        projects: [
            { id: 'project-owner', displayTitle: 'Owner', rootPath: ownerRoot },
            { id: 'project-worktree', displayTitle: 'Worktree', rootPath: workbenchRoot },
        ],
        sessions: [
            {
                id: 'session-1',
                archivedAt: undefined,
                projectId: 'project-owner',
                workbenchProjectId: 'project-worktree',
            },
        ],
        selectedSessionId: 'session-1',
    };
}

describe('path browser authority', () => {
    it('starts from the selected Session Workbench Project without using its owner root', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const request = vi.fn((method: string, parameters?: unknown) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse') {
                const browseParameters = parameters as {
                    directory: string;
                    query: string;
                    sessionId: string;
                };
                expect(browseParameters).toMatchObject({
                    query: '',
                    sessionId: 'session-1',
                });
                expect(browseParameters.directory).toContain('caxri-path-worktree-');
                expect(browseParameters.directory).not.toBe(ownerRoot);
                return Promise.resolve({
                    entries: [
                        {
                            kind: 'file',
                            name: 'worktree.ts',
                            path: join(workbenchRoot, 'worktree.ts'),
                        },
                    ],
                    truncated: false,
                });
            }
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => {},
            openFile: vi.fn(),
        });

        await expect(authority.start({ sessionId: 'session-1' })).resolves.toMatchObject({
            canCreate: true,
            directoryLabel: '',
            entries: [{ kind: 'file', name: 'worktree.ts' }],
            rootLabel: 'Worktree',
        });
    });

    it('does not enumerate Home until a native grant, then exposes only opaque entries', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const userHome = await temporaryDirectory('caxri-path-home-');
        const externalRoot = join(userHome, 'outside');
        await mkdir(externalRoot);
        await writeFile(join(externalRoot, 'external.ts'), 'export const external = true;\n');
        const state = bootstrap(ownerRoot, workbenchRoot);
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(state);
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => externalRoot,
            openFile: vi.fn(),
            userHome,
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        const result = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'input', value: '~/outside/' },
        });

        expect(result).toMatchObject({
            browserId: initial.browserId,
            canCreate: false,
            entries: [{ kind: 'file', name: 'external.ts' }],
        });
        expect(JSON.stringify(result)).not.toContain(externalRoot);
        expect(request.mock.calls.map(([method]) => method)).toEqual([
            'app.bootstrap',
            'files.browse',
            'app.bootstrap',
        ]);
        expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled();

        authority.close({ browserId: initial.browserId });
        await expect(
            authority.browse({ browserId: initial.browserId, query: '' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('consumes an external grant after opening and rejects a symlink escape', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const userHome = await temporaryDirectory('caxri-path-home-');
        const externalRoot = join(userHome, 'outside');
        const outsideRoot = await temporaryDirectory('caxri-path-escape-');
        await mkdir(externalRoot);
        await writeFile(join(externalRoot, 'external.ts'), 'export const external = true;\n');
        await writeFile(join(outsideRoot, 'secret.ts'), 'secret\n');
        await symlink(join(outsideRoot, 'secret.ts'), join(externalRoot, 'escape.ts'));
        const state = bootstrap(ownerRoot, workbenchRoot);
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(state);
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const openFile = vi.fn<(target: PathBrowserOpenTarget) => Promise<{ opened: true }>>();
        openFile.mockResolvedValue({ opened: true });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => externalRoot,
            openFile,
            userHome,
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        const result = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'input', value: '~/outside/' },
        });
        if (!('entries' in result)) throw new Error('Expected a path browser snapshot');
        const external = result.entries.find((entry) => entry.name === 'external.ts');
        const escape = result.entries.find((entry) => entry.name === 'escape.ts');
        expect(external).toBeDefined();
        expect(escape?.kind).toBe('symlink');

        await expect(
            authority.open({ browserId: initial.browserId, entryId: escape!.id }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            authority.open({ browserId: initial.browserId, entryId: external!.id }),
        ).resolves.toEqual({ opened: true });
        const [target] = openFile.mock.calls[0];
        expect(target.projectId).toBeUndefined();
        expect(typeof target.grantRoot?.path).toBe('string');
        expect(typeof target.path).toBe('string');
        await expect(
            authority.open({ browserId: initial.browserId, entryId: external!.id }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('expires a temporary browse grant without revealing or retaining its root', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const userHome = await temporaryDirectory('caxri-path-home-');
        const externalRoot = join(userHome, 'outside');
        await mkdir(externalRoot);
        let now = 1_000;
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            grantTtlMs: 50,
            nextTestRoot: () => externalRoot,
            now: () => now,
            openFile: vi.fn(),
            userHome,
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'input', value: '~/outside/' },
        });
        now += 51;

        await expect(
            authority.browse({ browserId: initial.browserId, query: '' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('opens a pasted absolute file after one parent-folder grant', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-absolute-');
        const file = join(externalRoot, 'absolute.ts');
        await writeFile(file, 'export const absolute = true;\n');
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const openFile = vi.fn<(target: PathBrowserOpenTarget) => Promise<{ opened: true }>>();
        openFile.mockResolvedValue({ opened: true });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => externalRoot,
            openFile,
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        await expect(
            authority.navigate({
                browserId: initial.browserId,
                target: { kind: 'input', value: file },
            }),
        ).resolves.toEqual({ opened: true });
        expect(openFile).toHaveBeenCalledOnce();
        expect(openFile.mock.calls[0][0].path).toContain('absolute.ts');
    });

    it('returns a stable content-free error for a missing absolute path', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-missing-');
        const missingFile = join(externalRoot, 'private-missing.ts');
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => externalRoot,
            openFile: vi.fn(),
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        let error: unknown;
        try {
            await authority.navigate({
                browserId: initial.browserId,
                target: { kind: 'input', value: missingFile },
            });
        } catch (error_) {
            error = error_;
        }
        expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'File not found' });
        expect(JSON.stringify(error)).not.toContain(missingFile);
    });

    it('keeps the existing browser context when folder authorization is canceled', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => {},
            openFile: vi.fn(),
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        await expect(
            authority.navigate({
                browserId: initial.browserId,
                target: { kind: 'input', value: '/outside/file.ts' },
            }),
        ).resolves.toEqual({ canceled: true });
        await expect(
            authority.browse({ browserId: initial.browserId, query: '' }),
        ).resolves.toMatchObject({ browserId: initial.browserId, rootLabel: 'Worktree' });
    });

    it('rejects a replaced grant root before opening a listed file', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-replaced-');
        await writeFile(join(externalRoot, 'target.ts'), 'first\n');
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => externalRoot,
            openFile: vi.fn(),
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        const listed = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'input', value: `${externalRoot}/` },
        });
        if (!('entries' in listed)) throw new Error('Expected a path browser snapshot');
        const target = listed.entries.find((entry) => entry.name === 'target.ts');
        const movedRoot = `${externalRoot}-old`;
        temporaryDirectories.push(movedRoot);
        await rename(externalRoot, movedRoot);
        await mkdir(externalRoot);
        await writeFile(join(externalRoot, 'target.ts'), 'replacement\n');

        await expect(
            authority.open({ browserId: initial.browserId, entryId: target!.id }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects a file replaced after the external directory was listed', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-target-replaced-');
        const targetPath = join(externalRoot, 'target.ts');
        const previousPath = join(externalRoot, 'target.previous.ts');
        await writeFile(targetPath, 'first\n');
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse')
                return Promise.resolve({ entries: [], truncated: false });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => externalRoot,
            openFile: vi.fn(),
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        const listed = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'input', value: `${externalRoot}/` },
        });
        if (!('entries' in listed)) throw new Error('Expected a path browser snapshot');
        const target = listed.entries.find((entry) => entry.name === 'target.ts');
        await rename(targetPath, previousPath);
        await writeFile(targetPath, 'replacement\n');

        await expect(
            authority.open({ browserId: initial.browserId, entryId: target!.id }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('serializes Project browsing so a stale response cannot replace current entry IDs', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        let resolveFirstBrowse: ((value: unknown) => void) | undefined;
        let resolveSecondBrowse: ((value: unknown) => void) | undefined;
        const request = vi.fn((method: string, parameters?: unknown) => {
            if (method === 'app.bootstrap')
                return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
            if (method === 'files.browse') {
                const query = (parameters as { query: string }).query;
                if (!query) return Promise.resolve({ entries: [], truncated: false });
                return new Promise((resolve) => {
                    if (query === 'first') resolveFirstBrowse = resolve;
                    else resolveSecondBrowse = resolve;
                });
            }
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const authority = createPathBrowserAuthority({
            getServer: () => server(request),
            getWindow: () => {},
            nextTestRoot: () => {},
            openFile: vi.fn(),
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        const first = authority.browse({ browserId: initial.browserId, query: 'first' });
        const second = authority.browse({ browserId: initial.browserId, query: 'second' });
        await vi.waitFor(() => {
            expect(resolveFirstBrowse).toBeTypeOf('function');
        });
        expect(resolveSecondBrowse).toBeUndefined();

        resolveFirstBrowse!({
            entries: [{ kind: 'file', name: 'first.ts', path: join(workbenchRoot, 'first.ts') }],
            truncated: false,
        });
        await first;
        await vi.waitFor(() => {
            expect(resolveSecondBrowse).toBeTypeOf('function');
        });
        resolveSecondBrowse!({
            entries: [{ kind: 'file', name: 'second.ts', path: join(workbenchRoot, 'second.ts') }],
            truncated: false,
        });
        await expect(second).resolves.toMatchObject({
            entries: [{ kind: 'file', name: 'second.ts' }],
        });
    });
});
