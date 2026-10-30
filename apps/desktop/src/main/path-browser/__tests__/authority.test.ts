import { Buffer } from 'node:buffer';
import { link, lstat, mkdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_CONFIGURABLE_FILE_BYTES, MAX_FILE_BROWSE_ENTRIES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { readBoundedExternalContent } from '../../external-documents/snapshot';
import { authorityOptions, bootstrap, registerTemporaryDirectories } from './authority.fixture';

const temporaryDirectory = registerTemporaryDirectories();

describe('path browser authority', () => {
    it('opens and expands unprobed workspace links using the current Server-authorized kind', async () => {
        const workspace = await temporaryDirectory('caxri-path-linked-workspace-');
        const outside = await temporaryDirectory('caxri-path-linked-target-');
        const root = await realpath(workspace);
        await writeFile(join(outside, 'fixture.txt'), 'fixture');
        await symlink(outside, join(root, 'folder-link'));
        await symlink(join(outside, 'fixture.txt'), join(root, 'file-link'));
        const { authority, openFile, request } = authorityOptions(root, root, {
            async request(method, parameters) {
                if (method === 'app.bootstrap') return bootstrap(root, root);
                const input = parameters as { directory?: string; path?: string };
                if (method === 'files.browse')
                    return {
                        entries:
                            input.directory === root
                                ? ['folder-link', 'file-link'].map((name) => ({
                                      kind: 'symlink',
                                      name,
                                      path: join(root, name),
                                  }))
                                : [
                                      {
                                          kind: 'file',
                                          name: 'fixture.txt',
                                          path: join(input.directory!, 'fixture.txt'),
                                      },
                                  ],
                        truncated: false,
                    };
                if (method === 'files.authorizeOpen') {
                    const [stats, rootStats] = await Promise.all([
                        lstat(await realpath(input.path!), { bigint: true }),
                        lstat(root, { bigint: true }),
                    ]);
                    return {
                        path: input.path,
                        kind: stats.isDirectory() ? 'directory' : 'file',
                        device: stats.dev.toString(),
                        inode: stats.ino.toString(),
                        root: {
                            path: root,
                            device: rootStats.dev.toString(),
                            inode: rootStats.ino.toString(),
                        },
                    };
                }
                throw new Error(`Unexpected method: ${method}`);
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        const nested = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'entry', entryId: initial.entries[0].id },
        });
        expect(nested).toMatchObject({ entries: [{ name: 'fixture.txt' }] });
        expect(request).toHaveBeenLastCalledWith('files.browse', {
            sessionId: 'session-1',
            directory: join(root, 'folder-link'),
            query: '',
        });
        const reopened = await authority.start({ sessionId: 'session-1' });
        await expect(
            authority.navigate({
                browserId: reopened.browserId,
                target: { kind: 'entry', entryId: reopened.entries[1].id },
            }),
        ).resolves.toMatchObject({ opened: true, kind: 'project' });
        expect(openFile).toHaveBeenCalledWith(
            expect.objectContaining({ path: join(root, 'file-link') }),
        );
    });

    it('starts from the Workbench Project and detaches to its absolute directory without a picker', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const canonicalWorkbenchRoot = await realpath(workbenchRoot);
        const { authority } = authorityOptions(ownerRoot, workbenchRoot);

        const initial = await authority.start({ sessionId: 'session-1' });
        expect(initial).toMatchObject({
            canCreate: true,
            directoryLabel: '',
            input: '',
            mode: 'project',
            rootLabel: 'Worktree',
        });

        const detached = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'detachProject' },
        });
        // The location moves to the breadcrumb, not into the field: detaching exists so the user can type a path of
        // their own, and handing them the absolute path they are standing on means deleting it first.
        expect(detached).toMatchObject({
            browserId: initial.browserId,
            canCreate: false,
            directoryLabel: `${canonicalWorkbenchRoot}/`,
            input: '',
            mode: 'free',
        });
        expect(detached).not.toHaveProperty('rootLabel');
    });

    it('keeps the current Project directory chrome stable while browsing nested input', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const sourceDirectory = join(workbenchRoot, 'src');
        await mkdir(sourceDirectory);
        const canonicalSourceDirectory = await realpath(sourceDirectory);
        const { authority, request } = authorityOptions(ownerRoot, workbenchRoot);
        const initial = await authority.start({ sessionId: 'session-1' });

        const nested = await authority.browse({
            browserId: initial.browserId,
            mode: 'project',
            input: 'src/rea',
        });

        expect(nested).toMatchObject({ directoryLabel: '', input: 'src/rea', mode: 'project' });
        expect(request).toHaveBeenLastCalledWith('files.browse', {
            sessionId: 'session-1',
            directory: canonicalSourceDirectory,
            query: 'rea',
        });
    });

    it('keeps the Project-local trailing-slash create-folder gesture', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const canonicalWorkbenchRoot = await realpath(workbenchRoot);
        const { authority, request } = authorityOptions(ownerRoot, workbenchRoot);
        const initial = await authority.start({ sessionId: 'session-1' });

        const missingFolder = await authority.browse({
            browserId: initial.browserId,
            mode: 'project',
            input: 'drafts/',
        });

        expect(missingFolder).toMatchObject({
            canCreate: true,
            directoryLabel: '',
            entries: [],
            input: 'drafts/',
        });
        expect(request).toHaveBeenLastCalledWith('files.browse', {
            sessionId: 'session-1',
            directory: canonicalWorkbenchRoot,
            query: 'drafts',
        });
    });

    it('forwards the Server symlink target metadata into Project snapshot entries', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const canonicalWorkbenchRoot = await realpath(workbenchRoot);
        const { authority } = authorityOptions(ownerRoot, workbenchRoot, {
            request(method: string) {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({
                        entries: [
                            {
                                kind: 'symlink',
                                linkKind: 'directory',
                                linkTarget: 'real-dir',
                                name: 'link-to-dir',
                                path: join(canonicalWorkbenchRoot, 'link-to-dir'),
                            },
                            {
                                kind: 'symlink',
                                name: 'unprobed-link',
                                path: join(canonicalWorkbenchRoot, 'unprobed-link'),
                            },
                            {
                                kind: 'file',
                                name: 'plain.ts',
                                path: join(canonicalWorkbenchRoot, 'plain.ts'),
                            },
                        ],
                        truncated: false,
                    });
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });

        const initial = await authority.start({ sessionId: 'session-1' });

        const entries = initial.entries.map(({ id, ...entry }) => {
            expect(id).toEqual(expect.any(String));
            return entry;
        });
        expect(entries).toEqual([
            {
                kind: 'symlink',
                linkKind: 'directory',
                linkTarget: 'real-dir',
                name: 'link-to-dir',
                source: 'directory',
            },
            // A link the Server probe could not describe carries no invented metadata.
            { kind: 'symlink', name: 'unprobed-link', source: 'directory' },
            { kind: 'file', name: 'plain.ts', source: 'directory' },
        ]);
    });

    it('lists the shallowest Project directory Server Core located for a relative path suffix', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const canonicalWorkbenchRoot = await realpath(workbenchRoot);
        const shallow = join(canonicalWorkbenchRoot, 'example', 'packages', 'bank');
        const deep = join(canonicalWorkbenchRoot, 'apps', 'web', 'vendor', 'packages', 'bank');
        await mkdir(shallow, { recursive: true });
        await mkdir(deep, { recursive: true });
        const { authority, request } = authorityOptions(ownerRoot, workbenchRoot, {
            request(method: string, parameters?: unknown) {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({ entries: [], truncated: false });
                if (method === 'files.locateDirectory') {
                    const { suffix } = parameters as { suffix: string };
                    return Promise.resolve({
                        path: suffix === 'packages/bank' ? shallow : null,
                        truncated: false,
                    });
                }
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        const located = await authority.browse({
            browserId: initial.browserId,
            mode: 'project',
            input: 'packages/bank/index.ts',
        });
        expect(located).toMatchObject({
            directoryLabel: 'example/',
            input: 'packages/bank/index.ts',
            mode: 'project',
        });
        expect(request).toHaveBeenCalledWith('files.locateDirectory', {
            sessionId: 'session-1',
            suffix: 'packages/bank',
        });
        expect(request).toHaveBeenLastCalledWith('files.browse', {
            sessionId: 'session-1',
            directory: shallow,
            query: 'index.ts',
        });

        request.mockClear();
        await mkdir(join(shallow, 'src'));
        const deeper = await authority.browse({
            browserId: initial.browserId,
            mode: 'project',
            input: 'packages/bank/src/',
        });
        expect(deeper).toMatchObject({ directoryLabel: 'example/', input: 'packages/bank/src/' });
        expect(request).not.toHaveBeenCalledWith('files.locateDirectory', expect.anything());

        await expect(
            authority.browse({
                browserId: initial.browserId,
                mode: 'project',
                input: 'nowhere/bank/index.ts',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'File not found' });
        request.mockClear();
        await expect(
            authority.browse({
                browserId: initial.browserId,
                mode: 'project',
                input: 'nowhere/bank/deeper/index.ts',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(request).not.toHaveBeenCalledWith('files.locateDirectory', expect.anything());

        request.mockClear();
        await expect(
            authority.browse({
                browserId: initial.browserId,
                mode: 'project',
                input: '../packages/bank/index.ts',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(request).not.toHaveBeenCalledWith('files.locateDirectory', expect.anything());
    });

    it('ignores a located directory Server Core reported outside the browse root', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const outside = join(await realpath(ownerRoot), 'packages', 'bank');
        await mkdir(outside, { recursive: true });
        const { authority, request } = authorityOptions(ownerRoot, workbenchRoot, {
            request(method: string) {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({ entries: [], truncated: false });
                if (method === 'files.locateDirectory')
                    return Promise.resolve({ path: outside, truncated: false });
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        await expect(
            authority.browse({
                browserId: initial.browserId,
                mode: 'project',
                input: 'packages/bank/index.ts',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'File not found' });

        // The rejected path must never become a memoized prefix, so a deeper suffix stays a negative memo hit.
        request.mockClear();
        await expect(
            authority.browse({
                browserId: initial.browserId,
                mode: 'project',
                input: 'packages/bank/src/index.ts',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(request).not.toHaveBeenCalledWith('files.locateDirectory', expect.anything());
    });

    it('reports the Project as too large when the locate traversal was truncated without a match', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const { authority } = authorityOptions(ownerRoot, workbenchRoot, {
            request(method: string) {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({ entries: [], truncated: false });
                if (method === 'files.locateDirectory')
                    return Promise.resolve({ path: null, truncated: true });
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        await expect(
            authority.browse({
                browserId: initial.browserId,
                mode: 'project',
                input: 'packages/bank/index.ts',
            }),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
            message: 'File not found; the Project is too large to locate a matching folder',
        });
    });

    it('live-lists Home, parent, relative, and absolute free paths with opaque entries', async () => {
        const container = await temporaryDirectory('caxri-path-free-');
        const ownerRoot = join(container, 'owner');
        const workbenchRoot = join(container, 'project');
        const externalRoot = join(container, 'external');
        const userHome = join(container, 'home');
        await Promise.all([
            mkdir(ownerRoot),
            mkdir(workbenchRoot),
            mkdir(externalRoot),
            mkdir(userHome),
        ]);
        await Promise.all([
            writeFile(join(externalRoot, 'external.ts'), 'external\n'),
            writeFile(join(userHome, 'home.ts'), 'home\n'),
        ]);
        const { authority } = authorityOptions(ownerRoot, workbenchRoot, { userHome });
        const initial = await authority.start({ sessionId: 'session-1' });
        await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'detachProject' },
        });

        for (const input of ['~', '~/', '~/ho']) {
            // eslint-disable-next-line no-await-in-loop -- each request verifies another supported input form
            const result = await authority.browse({
                browserId: initial.browserId,
                mode: 'free',
                input,
            });
            expect(result.entries.map((entry) => entry.name)).toContain('home.ts');
        }
        for (const input of [`${externalRoot}/`, '../external/']) {
            // eslint-disable-next-line no-await-in-loop -- each request verifies another supported input form
            const result = await authority.browse({
                browserId: initial.browserId,
                mode: 'free',
                input,
            });
            expect(result.entries).toEqual([
                expect.objectContaining({ kind: 'file', name: 'external.ts' }),
            ]);
            expect(JSON.stringify(result.entries)).not.toContain(externalRoot);
        }
        const parent = await authority.browse({
            browserId: initial.browserId,
            mode: 'free',
            input: '..',
        });
        expect(parent.entries.map((entry) => entry.name)).toEqual(
            expect.arrayContaining(['external', 'project']),
        );
    });

    it('opens a free file as one bounded document without Project or Session routing', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-external-');
        const externalPath = join(externalRoot, 'external.ts');
        await writeFile(externalPath, 'export const external = true;\n');
        const canonicalExternalPath = await realpath(externalPath);
        const { authority, openFile, request } = authorityOptions(ownerRoot, workbenchRoot);
        const initial = await authority.start({ sessionId: 'session-1' });
        const listed = await authority.browse({
            browserId: initial.browserId,
            mode: 'free',
            input: `${externalRoot}/`,
        });
        const external = listed.entries.find((entry) => entry.name === 'external.ts');

        await expect(
            authority.open({ browserId: initial.browserId, entryId: external!.id }),
        ).resolves.toMatchObject({
            opened: true,
            kind: 'external',
            document: {
                name: 'external.ts',
                displayPath: canonicalExternalPath,
                content: 'export const external = true;\n',
            },
        });
        expect(openFile).not.toHaveBeenCalled();
        expect(request.mock.calls.map(([method]) => method)).not.toContain('project.create');
        expect(request.mock.calls.map(([method]) => method)).not.toContain('session.create');
        await expect(
            authority.open({ browserId: initial.browserId, entryId: external!.id }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('keeps Project files on the Server authorization and Desktop open chain', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const targetPath = join(workbenchRoot, 'project.ts');
        await writeFile(targetPath, 'project\n');
        const [rootStats, fileStats] = await Promise.all([
            lstat(workbenchRoot, { bigint: true }),
            lstat(targetPath, { bigint: true }),
        ]);
        const { authority, openFile } = authorityOptions(ownerRoot, workbenchRoot, {
            request: (method) => {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({
                        entries: [{ kind: 'file', name: 'project.ts', path: targetPath }],
                        truncated: false,
                    });
                if (method === 'files.authorizeOpen')
                    return Promise.resolve({
                        kind: 'file',
                        name: 'project.ts',
                        path: targetPath,
                        device: fileStats.dev.toString(),
                        inode: fileStats.ino.toString(),
                        root: {
                            path: workbenchRoot,
                            device: rootStats.dev.toString(),
                            inode: rootStats.ino.toString(),
                        },
                    });
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        const projectFile = initial.entries.find((entry) => entry.name === 'project.ts');

        await expect(
            authority.open({ browserId: initial.browserId, entryId: projectFile!.id }),
        ).resolves.toEqual({ opened: true, kind: 'project' });
        expect(openFile).toHaveBeenCalledWith(
            expect.objectContaining({ path: targetPath, sessionId: 'session-1' }),
        );
    });

    it('keeps a current-Project file editable after the Project anchor is detached', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const targetPath = join(workbenchRoot, 'project.ts');
        await writeFile(targetPath, 'project\n');
        const canonicalTargetPath = await realpath(targetPath);
        const [rootStats, fileStats] = await Promise.all([
            lstat(workbenchRoot, { bigint: true }),
            lstat(targetPath, { bigint: true }),
        ]);
        const { authority, openFile, request } = authorityOptions(ownerRoot, workbenchRoot, {
            request: (method) => {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(ownerRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({ entries: [], truncated: false });
                if (method === 'files.authorizeOpen')
                    return Promise.resolve({
                        kind: 'file',
                        name: 'project.ts',
                        path: canonicalTargetPath,
                        device: fileStats.dev.toString(),
                        inode: fileStats.ino.toString(),
                        root: {
                            path: workbenchRoot,
                            device: rootStats.dev.toString(),
                            inode: rootStats.ino.toString(),
                        },
                    });
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        const detached = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'detachProject' },
        });
        if (!('browserId' in detached)) throw new Error('Expected a detached browser snapshot');
        const projectFile = detached.entries.find((entry) => entry.name === 'project.ts');

        await expect(
            authority.open({ browserId: initial.browserId, entryId: projectFile!.id }),
        ).resolves.toEqual({ opened: true, kind: 'project' });
        expect(request).toHaveBeenCalledWith('files.authorizeOpen', {
            sessionId: 'session-1',
            path: canonicalTargetPath,
        });
        expect(openFile).toHaveBeenCalledWith(
            expect.objectContaining({ path: canonicalTargetPath, sessionId: 'session-1' }),
        );
    });

    it('rejects symlinks, hard links, and files replaced after listing', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-unsafe-');
        const original = join(externalRoot, 'original.ts');
        const hardLink = join(externalRoot, 'hard.ts');
        const symbolicLink = join(externalRoot, 'symbolic.ts');
        const replaceable = join(externalRoot, 'replaceable.ts');
        await Promise.all([writeFile(original, 'original\n'), writeFile(replaceable, 'before\n')]);
        await Promise.all([link(original, hardLink), symlink(original, symbolicLink)]);
        const { authority } = authorityOptions(ownerRoot, workbenchRoot);
        const initial = await authority.start({ sessionId: 'session-1' });
        const listed = await authority.browse({
            browserId: initial.browserId,
            mode: 'free',
            input: `${externalRoot}/`,
        });
        const byName = new Map(listed.entries.map((entry) => [entry.name, entry]));
        expect(byName.get('symbolic.ts')?.kind).toBe('symlink');

        await expect(
            authority.open({
                browserId: initial.browserId,
                entryId: byName.get('symbolic.ts')!.id,
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            authority.open({ browserId: initial.browserId, entryId: byName.get('hard.ts')!.id }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });

        await rename(replaceable, join(externalRoot, 'previous.ts'));
        await writeFile(replaceable, 'replacement\n');
        await expect(
            authority.open({
                browserId: initial.browserId,
                entryId: byName.get('replaceable.ts')!.id,
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('bounds a file that grows during reading and detects binary bytes beyond the prefix', async () => {
        await expect(
            readBoundedExternalContent({
                read: (_buffer, _offset, length) => {
                    expect(length).toBe(MAX_CONFIGURABLE_FILE_BYTES + 1);
                    return Promise.resolve({ bytesRead: length });
                },
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });

        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-binary-');
        const binaryPath = join(externalRoot, 'binary.dat');
        await writeFile(binaryPath, Buffer.concat([Buffer.alloc(9_000, 65), Buffer.from([0])]));
        const { authority } = authorityOptions(ownerRoot, workbenchRoot);
        const initial = await authority.start({ sessionId: 'session-1' });
        const listed = await authority.browse({
            browserId: initial.browserId,
            mode: 'free',
            input: `${externalRoot}/`,
        });
        const binary = listed.entries.find((entry) => entry.name === 'binary.dat');

        await expect(
            authority.open({ browserId: initial.browserId, entryId: binary!.id }),
        ).rejects.toMatchObject({
            code: 'IO',
            message: 'Binary files cannot be opened in the editor',
        });
    });

    it('bounds a free directory scan and returns content-free filesystem errors', async () => {
        const ownerRoot = await temporaryDirectory('caxri-path-owner-');
        const workbenchRoot = await temporaryDirectory('caxri-path-worktree-');
        const externalRoot = await temporaryDirectory('caxri-path-bounded-');
        await Promise.all(
            Array.from({ length: MAX_FILE_BROWSE_ENTRIES + 5 }, (_, index) =>
                writeFile(join(externalRoot, `file-${index}.txt`), 'x'),
            ),
        );
        const { authority } = authorityOptions(ownerRoot, workbenchRoot);
        const initial = await authority.start({ sessionId: 'session-1' });
        const listed = await authority.browse({
            browserId: initial.browserId,
            mode: 'free',
            input: `${externalRoot}/`,
        });
        expect(listed.entries).toHaveLength(MAX_FILE_BROWSE_ENTRIES);
        expect(listed.truncated).toBe(true);

        const missing = `${join(externalRoot, 'private-missing')}/`;
        let error: unknown;
        try {
            await authority.browse({
                browserId: initial.browserId,
                mode: 'free',
                input: missing,
            });
        } catch (error_) {
            error = error_;
        }
        expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'File not found' });
        expect(JSON.stringify(error)).not.toContain(missing);
    });
});
