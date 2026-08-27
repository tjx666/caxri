import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db';
import { FileService } from '../../files';
import { resolveTerminalFileLink } from '../file-links';

const databases: CaxriDatabase[] = [];
const fileServices: FileService[] = [];
const temporaryDirectories: string[] = [];

async function fixture() {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-terminal-file-link-'));
    temporaryDirectories.push(temporary);
    const userHome = await realpath(temporary);
    const sourceRoot = join(userHome, 'source');
    await mkdir(sourceRoot);
    const database = new CaxriDatabase(join(userHome, 'state.db'));
    databases.push(database);
    const source = database.createSession(database.createProject(sourceRoot).id, 'shell');
    const files = new FileService(
        database,
        () => {},
        new StructuredLogger(join(userHome, 'logs')),
        () => 1_024 * 1_024,
    );
    fileServices.push(files);
    return {
        database,
        files,
        sourceRoot,
        sourceSessionId: source.session.id,
        terminalId: source.terminal!.id,
        userHome,
    };
}

function searchOptions(files: FileService) {
    return {
        searchProjectFileNames: (
            sessionId: string,
            root: string,
            query: string,
            signal: AbortSignal,
        ) => files.searchProjectFileNames(sessionId, root, query, signal),
    };
}

afterEach(async () => {
    const pendingServices = [...fileServices];
    fileServices.length = 0;
    await Promise.all(pendingServices.map((service) => service.close()));
    const pendingDatabases = [...databases];
    databases.length = 0;
    for (const database of pendingDatabases) database.close();
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('resolveTerminalFileLink', () => {
    it('resolves a unique shortened suffix inside an authorized Project', async () => {
        const { database, files, sourceRoot, terminalId } = await fixture();
        const directory = join(sourceRoot, 'packages', 'services', 'artifactDeploymentQuota');
        const target = join(directory, 'index.test.ts');
        await mkdir(directory, { recursive: true });
        await writeFile(target, 'export {};\n');

        await expect(
            resolveTerminalFileLink(
                database,
                {
                    terminalId,
                    target: '.../services/artifactDeploymentQuota/index.test.ts',
                },
                searchOptions(files),
            ),
        ).resolves.toMatchObject({
            status: 'authorized',
            path: target,
        });
    });

    it('returns display candidates when a suffix is ambiguous across authorized Projects', async () => {
        const { database, files, sourceRoot, terminalId, userHome } = await fixture();
        const otherRoot = join(userHome, 'other-project');
        const relativeDirectory = join('packages', 'services', 'shared');
        const sourceTarget = join(sourceRoot, relativeDirectory, 'index.test.ts');
        const otherTarget = join(otherRoot, relativeDirectory, 'index.test.ts');
        await Promise.all([
            mkdir(join(sourceRoot, relativeDirectory), { recursive: true }),
            mkdir(join(otherRoot, relativeDirectory), { recursive: true }),
        ]);
        await Promise.all([writeFile(sourceTarget, 'source\n'), writeFile(otherTarget, 'other\n')]);
        database.createProject(otherRoot);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '.../services/shared/index.test.ts' },
                searchOptions(files),
            ),
        ).resolves.toMatchObject({
            status: 'ambiguous',
            candidates: [
                {
                    path: sourceTarget,
                    relativePath: 'packages/services/shared/index.test.ts',
                    projectTitle: 'source',
                },
                {
                    path: otherTarget,
                    relativePath: 'packages/services/shared/index.test.ts',
                    projectTitle: 'other-project',
                },
            ],
            truncated: false,
        });
    });

    it('returns a stable not-found error when no authorized suffix matches', async () => {
        const { database, files, terminalId } = await fixture();

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '.../services/missing/index.test.ts' },
                searchOptions(files),
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'File not found' });
    });

    it('does not silently open one match when the bounded search is incomplete', async () => {
        const { database, sourceRoot, terminalId } = await fixture();
        const directory = join(sourceRoot, 'packages', 'services', 'shared');
        const target = join(directory, 'index.test.ts');
        await mkdir(directory, { recursive: true });
        await writeFile(target, 'match\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '.../services/shared/index.test.ts' },
                {
                    searchProjectFileNames: () =>
                        Promise.resolve({
                            mode: 'name',
                            matches: [
                                {
                                    path: target,
                                    relativePath: 'packages/services/shared/index.test.ts',
                                },
                            ],
                            scannedFiles: 50_000,
                            truncated: true,
                            canceled: false,
                        }),
                },
            ),
        ).resolves.toMatchObject({
            status: 'ambiguous',
            candidates: [{ path: target }],
            truncated: true,
        });
    });

    it('resolves Project, cwd, and Git a/b exact candidates', async () => {
        const { database, files, sourceRoot, terminalId } = await fixture();
        const target = join(sourceRoot, 'src', 'file.ts');
        await mkdir(join(sourceRoot, 'src'));
        await writeFile(target, 'exact\n');

        await Promise.all(
            ['src/file.ts', './src/file.ts', 'a/src/file.ts', 'b/src/file.ts'].map((link) =>
                expect(
                    resolveTerminalFileLink(
                        database,
                        { terminalId, target: link },
                        searchOptions(files),
                    ),
                ).resolves.toMatchObject({ status: 'authorized', path: target }),
            ),
        );
    });

    it('does not guess across Projects when an ordinary relative path is missing', async () => {
        const { database, files, terminalId, userHome } = await fixture();
        const otherRoot = join(userHome, 'other-project');
        const otherTarget = join(otherRoot, 'src', 'file.ts');
        await mkdir(join(otherRoot, 'src'), { recursive: true });
        await writeFile(otherTarget, 'other\n');
        database.createProject(otherRoot);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'src/file.ts' },
                searchOptions(files),
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'File not found' });
    });

    it('normalizes an unavailable Project during suffix search without exposing ENOENT', async () => {
        const { database, files, terminalId, userHome } = await fixture();
        const unavailableRoot = join(userHome, 'unavailable-project');
        await mkdir(unavailableRoot);
        database.createProject(unavailableRoot);
        await rm(unavailableRoot, { recursive: true });

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '.../services/missing/index.test.ts' },
                searchOptions(files),
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'File not found' });
    });

    it('denies a non-Home symlink escape without falling back to suffix search', async () => {
        const { database, files, sourceRoot, terminalId, userHome } = await fixture();
        const outsideTarget = join(userHome, 'outside.ts');
        await writeFile(outsideTarget, 'secret\n');
        await symlink(outsideTarget, join(sourceRoot, 'linked.ts'));

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'linked.ts' },
                searchOptions(files),
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('denies an explicit absolute path outside every authorized Project', async () => {
        const { database, files, terminalId, userHome } = await fixture();
        const outsideTarget = join(userHome, 'outside.ts');
        await writeFile(outsideTarget, 'secret\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: outsideTarget },
                searchOptions(files),
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('authorizes a regular Home file already contained by an added Project', async () => {
        const { database, sourceSessionId, terminalId, userHome } = await fixture();
        const projectRoot = join(userHome, 'project');
        const target = join(projectRoot, 'src', 'file.ts');
        await mkdir(join(projectRoot, 'src'), { recursive: true });
        await writeFile(target, 'export {};\n');
        const project = database.createProject(projectRoot);
        const [rootIdentity, targetIdentity] = await Promise.all([
            lstat(projectRoot, { bigint: true }),
            lstat(target, { bigint: true }),
        ]);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/project/src/file.ts' },
                { userHome },
            ),
        ).resolves.toEqual({
            status: 'authorized',
            identity: {
                device: targetIdentity.dev.toString(),
                inode: targetIdentity.ino.toString(),
                root: {
                    path: projectRoot,
                    device: rootIdentity.dev.toString(),
                    inode: rootIdentity.ino.toString(),
                },
            },
            path: target,
            projectId: project.id,
            sourceSessionId,
        });
    });

    it('requires user authorization outside added Projects without probing target existence', async () => {
        const { database, terminalId, userHome } = await fixture();

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/not-yet-authorized/missing.ts' },
                { userHome },
            ),
        ).resolves.toMatchObject({
            status: 'authorization_required',
            path: join(userHome, 'not-yet-authorized', 'missing.ts'),
        });
    });

    it('authorizes only a user-selected root that contains the regular target', async () => {
        const { database, terminalId, userHome } = await fixture();
        const selectedRoot = join(userHome, 'selected');
        const otherRoot = join(userHome, 'other');
        const target = join(selectedRoot, 'file.ts');
        await Promise.all([mkdir(selectedRoot), mkdir(otherRoot)]);
        await writeFile(target, 'selected\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/selected/file.ts', selectedRoot },
                { userHome },
            ),
        ).resolves.toMatchObject({
            status: 'selection_authorized',
            path: target,
            rootPath: selectedRoot,
        });
        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/selected/file.ts', selectedRoot: otherRoot },
                { userHome },
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('denies a symlink that escapes an otherwise authorized Project root', async () => {
        const { database, terminalId, userHome } = await fixture();
        const projectRoot = join(userHome, 'project');
        const outsideRoot = join(userHome, 'outside');
        await Promise.all([mkdir(projectRoot), mkdir(outsideRoot)]);
        const outsideTarget = join(outsideRoot, 'secret.ts');
        await writeFile(outsideTarget, 'secret\n');
        await symlink(outsideTarget, join(projectRoot, 'linked.ts'));
        database.createProject(projectRoot);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/project/linked.ts' },
                { userHome },
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('normalizes missing in-Project targets to a bounded not-found error', async () => {
        const { database, terminalId, userHome } = await fixture();
        const projectRoot = join(userHome, 'project');
        await mkdir(projectRoot);
        database.createProject(projectRoot);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/project/missing.ts' },
                { userHome },
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it.each(['~', '~/', '~other/file.ts', '$HOME/file.ts', '${HOME}/file.ts', '~/../file.ts'])(
        'rejects unsupported or escaping Home syntax: %s',
        async (target) => {
            const { database, terminalId, userHome } = await fixture();

            await expect(
                resolveTerminalFileLink(database, { terminalId, target }, { userHome }),
            ).rejects.toMatchObject({
                code: target === '~/../file.ts' ? 'PATH_DENIED' : 'VALIDATION',
            });
        },
    );
});
