import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, realpath, rename, symlink } from 'node:fs/promises';

import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog }));

import { ProjectRootGrants } from '../root-grants';
import { workbenchRootHarness } from './support/workbench-root-harness';

const { authority, server, temporaryDirectory } = workbenchRootHarness(electronMock.dialog);

/**
 * Stands in for Server Core's `resolveProjectRoot` (apps/server/src/domains/project/root-identity.ts): apps cannot
 * import each other, so this mirrors its contract. The path must be a real directory (not a symlink) whose device and
 * inode match the expected identity; otherwise it fails with PATH_DENIED and nothing is inserted.
 */
function identityCheckingServer(inserted: string[]) {
    return server(async (method, parameters) => {
        const { rootPath, expectedRootIdentity: expected } = parameters as {
            rootPath: string;
            expectedRootIdentity?: { path: string; device: string; inode: string };
        };
        if (method !== 'project.create' || !expected)
            throw new CaxriError('VALIDATION', 'identity missing');
        let info: BigIntStats | undefined;
        try {
            info = await lstat(rootPath, { bigint: true });
        } catch {
            info = undefined;
        }
        if (
            !info ||
            info.isSymbolicLink() ||
            !info.isDirectory() ||
            info.dev.toString() !== expected.device ||
            info.ino.toString() !== expected.inode ||
            (await realpath(rootPath)) !== expected.path
        )
            throw new CaxriError('PATH_DENIED', 'Selected Project root changed before creation');
        inserted.push(expected.path);
        return { id: `project-${inserted.length}` };
    });
}

describe('picker -> grant -> create identity binding', () => {
    async function pick(path: string, nextGrants = new ProjectRootGrants()) {
        const inserted: string[] = [];
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({
            canceled: false,
            filePaths: [path],
        });
        const { instance, grants } = authority({
            getServer: identityCheckingServer(inserted),
            grants: nextGrants,
        });
        await expect(instance.selectProjectFolder()).resolves.toBe(path);
        return { grants, inserted, instance };
    }

    it('creates the Project for the picked folder', async () => {
        const root = await temporaryDirectory();
        const { inserted, instance } = await pick(root);

        await expect(instance.createProject({ rootPath: root })).resolves.toMatchObject({
            id: 'project-1',
        });
        expect(inserted).toEqual([root]);
        await expect(instance.createProject({ rootPath: root })).rejects.toThrow(
            'was not selected',
        );
    });

    it('denies creation when another folder replaced the picked one, inserts nothing, and spends the grant', async () => {
        const parent = await temporaryDirectory();
        const root = `${parent}/picked`;
        await mkdir(root);
        const { inserted, instance } = await pick(root);

        await rename(root, `${parent}/picked-original`);
        await mkdir(root);

        await expect(instance.createProject({ rootPath: root })).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
        expect(inserted).toEqual([]);
        await expect(instance.createProject({ rootPath: root })).rejects.toThrow(
            'was not selected',
        );
        expect(inserted).toEqual([]);
    });

    it('ignores an identity supplied by the Renderer', async () => {
        const parent = await temporaryDirectory();
        const root = `${parent}/picked`;
        await mkdir(root);
        const { inserted, instance } = await pick(root);
        await rename(root, `${parent}/picked-original`);
        await mkdir(root);
        const forgedInfo = await lstat(root, { bigint: true });
        const forged = {
            path: root,
            device: forgedInfo.dev.toString(),
            inode: forgedInfo.ino.toString(),
        };

        await expect(
            instance.createProject({ rootPath: root, expectedRootIdentity: forged }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        expect(inserted).toEqual([]);
    });

    it('creates the canonical target when the picked folder is a symlink', async () => {
        const parent = await temporaryDirectory();
        const target = `${parent}/target`;
        const link = `${parent}/link`;
        await mkdir(target);
        await symlink(target, link);
        const { inserted, instance } = await pick(link);

        await expect(instance.createProject({ rootPath: link })).resolves.toMatchObject({
            id: 'project-1',
        });
        expect(inserted).toEqual([target]);
    });

    it('keeps expiry enforced for an identity-bound grant', async () => {
        vi.useFakeTimers();
        try {
            const root = await temporaryDirectory();
            const { instance } = await pick(root, new ProjectRootGrants(1_000));
            await vi.advanceTimersByTimeAsync(1_001);

            await expect(instance.createProject({ rootPath: root })).rejects.toThrow('expired');
        } finally {
            vi.useRealTimers();
        }
    });
});
