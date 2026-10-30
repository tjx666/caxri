import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopServerConnection } from '../../connection/server-connection';
import { createPathBrowserAuthority } from '../authority';
import { sshHostPathBrowserDirectories } from '../directories';

/**
 * An SSH Host's Project, which does not exist on this Mac: a browser that read the local disk for any of these paths
 * would fail with NOT_FOUND instead of listing them.
 */
const ROOT = '/home/dev/project';
const TREE: Record<string, Array<{ kind: 'directory' | 'file'; name: string }>> = {
    [ROOT]: [
        { kind: 'directory', name: 'src' },
        { kind: 'file', name: 'README.md' },
    ],
    [`${ROOT}/src`]: [{ kind: 'file', name: 'main.ts' }],
};

function answer(method: string, parameters?: unknown): unknown {
    if (method === 'app.bootstrap')
        return {
            projects: [{ id: 'project', title: 'project', rootPath: ROOT }],
            sessions: [
                { id: 'session-1', projectId: 'project', workbenchRootProjectId: 'project' },
            ],
        };
    const input = parameters as { directory?: string; path?: string };
    if (method === 'files.browse')
        return {
            entries: (TREE[input.directory!] ?? []).map((entry) => ({
                ...entry,
                path: `${input.directory}/${entry.name}`,
            })),
            truncated: false,
        };
    if (method === 'files.authorizeOpen') {
        const path = input.path!;
        if (path !== ROOT && !path.startsWith(`${ROOT}/`))
            throw new CaxriError('PATH_DENIED', 'Path is outside the Project root');
        return {
            path,
            kind: path in TREE ? 'directory' : 'file',
            device: '7',
            inode: String(path.length),
            root: { path: ROOT, device: '7', inode: '1' },
        };
    }
    if (method === 'files.search') return { matches: [], truncated: false, canceled: false };
    throw new Error(`Unexpected method: ${method}`);
}

function remoteServer() {
    // The executor turns a thrown refusal into a rejection, as the real connection reports it.
    const request = vi.fn((method: string, parameters?: unknown) =>
        Promise.try(() => answer(method, parameters)),
    );
    return { request, server: { request } as unknown as DesktopServerConnection };
}

function remoteAuthority() {
    const { request, server } = remoteServer();
    const openFile = vi.fn(() => Promise.resolve({ opened: true as const }));
    const authority = createPathBrowserAuthority({
        directories: sshHostPathBrowserDirectories(() => server),
        getServer: () => server,
        logger: () => {},
        openFile,
        userHome: '/Users/someone',
    });
    return { authority, openFile, request };
}

describe('path browser in an SSH Host window', () => {
    it('lists, enters, and opens Project files through the remote Server alone', async () => {
        const { authority, openFile } = remoteAuthority();
        const initial = await authority.start({ sessionId: 'session-1' });
        expect(initial.entries.map((entry) => entry.name)).toEqual(['src', 'README.md']);

        const source = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'entry', entryId: initial.entries[0].id },
        });
        expect(source).toMatchObject({ directoryLabel: 'src/', entries: [{ name: 'main.ts' }] });
        const [file] = (source as typeof initial).entries;
        await expect(
            authority.open({ browserId: initial.browserId, entryId: file.id }),
        ).resolves.toEqual({ opened: true, kind: 'project' });
        expect(openFile).toHaveBeenCalledWith({
            expectedIdentity: {
                device: '7',
                inode: String(`${ROOT}/src/main.ts`.length),
                root: { path: ROOT, device: '7', inode: '1' },
            },
            path: `${ROOT}/src/main.ts`,
            sessionId: 'session-1',
        });
    });

    it('reaches a remote Project folder by its absolute path and climbs back to the root', async () => {
        const { authority } = remoteAuthority();
        const initial = await authority.start({ sessionId: 'session-1' });
        const typed = await authority.browse({
            browserId: initial.browserId,
            mode: 'project',
            input: `${ROOT}/src/`,
        });
        expect(typed).toMatchObject({ entries: [{ name: 'main.ts' }] });

        const parent = await authority.navigate({
            browserId: initial.browserId,
            target: { kind: 'parent' },
        });
        expect(parent).toMatchObject({ canGoParent: false, directoryLabel: '' });
    });

    it('never browses outside the Project or this Mac’s home', async () => {
        const { authority, request } = remoteAuthority();
        const { browserId } = await authority.start({ sessionId: 'session-1' });

        await expect(
            authority.browse({ browserId, mode: 'free', input: '/etc/' }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await expect(
            authority.navigate({ browserId, target: { kind: 'detachProject' } }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await expect(
            authority.browse({ browserId, mode: 'project', input: '~/' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED', details: { reason: 'homeUnavailable' } });
        await expect(
            authority.browse({ browserId, mode: 'project', input: '/etc/' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED', details: { reason: 'outsideProjectRoot' } });
        expect(request).not.toHaveBeenCalledWith(
            'files.browse',
            expect.objectContaining({ directory: '/etc' }),
        );
    });
});
