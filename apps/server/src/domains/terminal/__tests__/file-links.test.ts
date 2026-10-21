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
const loggers: StructuredLogger[] = [];
const temporaryDirectories: string[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function fixture(options?: ConstructorParameters<typeof FileService>[4]) {
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
        createLogger(join(userHome, 'logs')),
        () => 1_024 * 1_024,
        options,
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
        searchProjectFileSuffixes: (
            sessionId: string,
            root: string,
            suffix: string,
            signal: AbortSignal,
        ) => files.searchProjectFileSuffixes(sessionId, root, suffix, signal),
    };
}

afterEach(async () => {
    const pendingServices = [...fileServices];
    fileServices.length = 0;
    await Promise.all(pendingServices.map((service) => service.close()));
    // The fixture owns the logger; service shutdown alone does not drain its queued filesystem writes.
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    const pendingDatabases = [...databases];
    databases.length = 0;
    for (const database of pendingDatabases) database.close();
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('resolveTerminalFileLink', () => {
    it('resolves a unique relative-path suffix inside the current Project', async () => {
        const { database, files, sourceRoot, terminalId } = await fixture();
        const directory = join(sourceRoot, 'example', 'apps', 'server', 'src', 'routers');
        const target = join(directory, 'message.ts');
        await mkdir(directory, { recursive: true });
        await writeFile(target, 'export {};\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'apps/server/src/routers/message.ts' },
                searchOptions(files),
            ),
        ).resolves.toMatchObject({
            status: 'authorized',
            path: target,
        });
    });

    it('finds a relative-path suffix after the generic file-scan budget is exhausted', async () => {
        const { database, files, sourceRoot, terminalId } = await fixture({
            search: { maxScannedFiles: 1 },
        });
        const targetDirectory = join(sourceRoot, 'alpha', 'apps', 'server', 'src', 'routers');
        const target = join(targetDirectory, 'message.ts');
        const busyDirectory = join(sourceRoot, 'z-busy');
        await Promise.all([
            mkdir(targetDirectory, { recursive: true }),
            mkdir(busyDirectory, { recursive: true }),
        ]);
        await Promise.all([
            writeFile(target, 'export {};\n'),
            writeFile(join(busyDirectory, 'decoy.ts'), 'export {};\n'),
        ]);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'apps/server/src/routers/message.ts' },
                searchOptions(files),
            ),
        ).resolves.toMatchObject({
            status: 'authorized',
            path: target,
        });
    });

    it('keeps suffix guessing case-insensitive', async () => {
        const { database, files, sourceRoot, terminalId } = await fixture();
        const directory = join(sourceRoot, 'Nested', 'Apps', 'Server');
        const target = join(directory, 'Message.ts');
        await mkdir(directory, { recursive: true });
        await writeFile(target, 'export {};\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'apps/server/message.ts' },
                searchOptions(files),
            ),
        ).resolves.toMatchObject({ status: 'authorized', path: target });
    });

    it.each(['a/', 'b/'])(
        'resolves a unique relative-path suffix after a Git %s prefix',
        async (prefix) => {
            const { database, files, sourceRoot, terminalId } = await fixture();
            const directory = join(sourceRoot, 'example', 'apps', 'server');
            const target = join(directory, 'message.ts');
            await mkdir(directory, { recursive: true });
            await writeFile(target, 'export {};\n');

            await expect(
                resolveTerminalFileLink(
                    database,
                    { terminalId, target: `${prefix}apps/server/message.ts` },
                    searchOptions(files),
                ),
            ).resolves.toMatchObject({ status: 'authorized', path: target });
        },
    );

    it('returns candidates when a relative-path suffix is ambiguous inside the current Project', async () => {
        const { database, files, sourceRoot, terminalId } = await fixture();
        const alpha = join(sourceRoot, 'alpha', 'apps', 'server', 'message.ts');
        const beta = join(sourceRoot, 'beta', 'apps', 'server', 'message.ts');
        await Promise.all([
            mkdir(join(sourceRoot, 'alpha', 'apps', 'server'), { recursive: true }),
            mkdir(join(sourceRoot, 'beta', 'apps', 'server'), { recursive: true }),
        ]);
        await Promise.all([writeFile(alpha, 'alpha\n'), writeFile(beta, 'beta\n')]);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'apps/server/message.ts' },
                searchOptions(files),
            ),
        ).resolves.toMatchObject({
            status: 'ambiguous',
            candidates: [{ path: alpha }, { path: beta }],
            truncated: false,
        });
    });

    it('searches only the selected Workbench Project for an ordinary relative suffix', async () => {
        const { database, files, sourceRoot, sourceSessionId, terminalId, userHome } =
            await fixture();
        const workbenchRoot = join(userHome, 'workbench');
        const ownerTarget = join(sourceRoot, 'owner', 'apps', 'server', 'message.ts');
        const workbenchTarget = join(workbenchRoot, 'nested', 'apps', 'server', 'message.ts');
        await Promise.all([
            mkdir(join(sourceRoot, 'owner', 'apps', 'server'), { recursive: true }),
            mkdir(join(workbenchRoot, 'nested', 'apps', 'server'), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(ownerTarget, 'owner\n'),
            writeFile(workbenchTarget, 'workbench\n'),
        ]);
        const workbench = database.createProject(workbenchRoot);
        database.selectWorkbenchProject(sourceSessionId, workbench.id);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'apps/server/message.ts' },
                searchOptions(files),
            ),
        ).resolves.toMatchObject({ status: 'authorized', path: workbenchTarget });
    });

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

    it('does not guess through directories excluded from Project traversal', async () => {
        const { database, files, sourceRoot, terminalId } = await fixture();
        const directory = join(sourceRoot, 'nested', 'node_modules', 'package');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'index.ts'), 'export {};\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'node_modules/package/index.ts' },
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
                    searchProjectFileSuffixes: () =>
                        Promise.resolve({
                            matches: [
                                {
                                    path: target,
                                    relativePath: 'packages/services/shared/index.test.ts',
                                },
                            ],
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

    it('does not report not-found when the bounded search ends before finding a candidate', async () => {
        const { database, terminalId } = await fixture();

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'apps/server/message.ts' },
                {
                    searchProjectFileSuffixes: () =>
                        Promise.resolve({ matches: [], truncated: true, canceled: false }),
                },
            ),
        ).rejects.toMatchObject({
            code: 'CAPACITY',
            message: 'File search reached its safety limit before completion',
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

    it('rejects a suffix-search result outside the Project being searched', async () => {
        const { database, terminalId, userHome } = await fixture();
        const otherRoot = join(userHome, 'other-project');
        const otherTarget = join(otherRoot, 'apps', 'server', 'message.ts');
        await mkdir(join(otherRoot, 'apps', 'server'), { recursive: true });
        await writeFile(otherTarget, 'other\n');
        database.createProject(otherRoot);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: 'apps/server/message.ts' },
                {
                    searchProjectFileSuffixes: () =>
                        Promise.resolve({
                            matches: [
                                {
                                    path: otherTarget,
                                    relativePath: 'apps/server/message.ts',
                                },
                            ],
                            truncated: false,
                            canceled: false,
                        }),
                },
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
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

    it('reports an explicit absolute path outside every Project as external without reading it', async () => {
        const { database, files, sourceSessionId, terminalId, userHome } = await fixture();
        const outsideTarget = join(userHome, 'outside.ts');
        await writeFile(outsideTarget, 'secret\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: outsideTarget },
                searchOptions(files),
            ),
        ).resolves.toEqual({
            status: 'external',
            path: outsideTarget,
            sourceSessionId,
            trusted: false,
        });
    });

    it.each([
        ['absolute path', (path: string) => path],
        ['file URL', (path: string) => `file://${path}`],
    ])(
        'marks an external %s trusted only when a Trusted Folder contains it',
        async (_kind, toTarget) => {
            const { database, sourceSessionId, terminalId, userHome } = await fixture();
            const outsideTarget = join(userHome, '.example', 'secrets', 'runtime.json');

            await expect(
                resolveTerminalFileLink(
                    database,
                    { terminalId, target: toTarget(outsideTarget) },
                    { userHome, trustedFolders: [join(userHome, 'elsewhere')] },
                ),
            ).resolves.toEqual({
                status: 'external',
                path: outsideTarget,
                sourceSessionId,
                trusted: false,
            });
            await expect(
                resolveTerminalFileLink(
                    database,
                    { terminalId, target: toTarget(outsideTarget) },
                    { userHome, trustedFolders: [`${join(userHome, '.example')}/`] },
                ),
            ).resolves.toMatchObject({ status: 'external', trusted: true });
        },
    );

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
            kind: 'file',
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

    it('treats an auto-registered worktree Project as external until a live Session uses it as its Workbench Root', async () => {
        const { database, files, sourceRoot, sourceSessionId, terminalId, userHome } =
            await fixture();
        const worktreeRoot = join(userHome, 'worktree');
        const target = join(worktreeRoot, 'file.ts');
        await mkdir(worktreeRoot);
        await writeFile(target, 'export {};\n');
        const owner = database.findProjectByRootPath(sourceRoot)!;
        const worktree = database.createProject(worktreeRoot, owner.id);

        // Nobody could see a Session created inside the hidden worktree row, so Main gets the read-only path.
        await expect(
            resolveTerminalFileLink(database, { terminalId, target }, searchOptions(files)),
        ).resolves.toEqual({ status: 'external', path: target, sourceSessionId, trusted: false });

        database.selectWorkbenchProject(sourceSessionId, worktree.id);
        await expect(
            resolveTerminalFileLink(database, { terminalId, target }, searchOptions(files)),
        ).resolves.toMatchObject({ status: 'authorized', path: target, projectId: worktree.id });

        database.archiveSession(sourceSessionId);
        await expect(
            resolveTerminalFileLink(database, { terminalId, target }, searchOptions(files)),
        ).resolves.toMatchObject({ status: 'external', path: target });
    });

    it('reports a Home link outside added Projects as external without probing target existence', async () => {
        const { database, sourceSessionId, terminalId, userHome } = await fixture();

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/not-yet-authorized/missing.ts' },
                { userHome },
            ),
        ).resolves.toEqual({
            status: 'external',
            path: join(userHome, 'not-yet-authorized', 'missing.ts'),
            sourceSessionId,
            trusted: false,
        });
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
