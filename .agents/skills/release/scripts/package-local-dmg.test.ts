import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CommandExecutor, CommandResult } from './package-local-dmg';
import { packageLocalDmg, parseLocalDmgArguments } from './package-local-dmg';

const temporaryDirectories: string[] = [];

async function fixture() {
    const cwd = await mkdtemp(join(tmpdir(), 'caxri-local-dmg-'));
    temporaryDirectories.push(cwd);
    const packageSource = '{\n    "name": "caxri",\n    "version": "0.0.6"\n}\n';
    const lockSource = "lockfileVersion: '9.0'\n";
    await Promise.all([
        writeFile(join(cwd, 'package.json'), packageSource, 'utf8'),
        writeFile(join(cwd, 'pnpm-lock.yaml'), lockSource, 'utf8'),
    ]);
    return { cwd, lockSource, packageSource };
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

function success(stdout = '', stderr = ''): CommandResult {
    return { exitCode: 0, stderr, stdout };
}

function fakeExecutor(cwd: string, shouldPackageFail = false) {
    const calls: string[] = [];
    const executor: CommandExecutor = {
        async run(command, arguments_) {
            calls.push(`${command} ${arguments_.join(' ')}`);
            if (command === 'git' && arguments_[0] === 'status') return success('');
            if (command === 'git' && arguments_[0] === 'rev-parse') return success('head-sha\n');
            if (command === 'pnpm') {
                const version = arguments_[1];
                await writeFile(
                    join(cwd, 'package.json'),
                    `{\n    "name": "caxri",\n    "version": "${version}"\n}\n`,
                    'utf8',
                );
                await writeFile(
                    join(cwd, 'pnpm-lock.yaml'),
                    `lockfileVersion: '9.0'\n# temporary version ${version}\n`,
                    'utf8',
                );
                return success(`v${version}\n`);
            }
            if (command === 'bun') {
                if (shouldPackageFail) return { exitCode: 1, stderr: 'builder failed', stdout: '' };
                const app = join(cwd, 'release.noindex', 'mac-arm64', 'Caxri.app');
                await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
                await Promise.all([
                    writeFile(join(cwd, 'release.noindex', 'Caxri-0.0.7-arm64.dmg'), 'dmg', 'utf8'),
                    writeFile(join(app, 'Contents', 'Info.plist'), 'plist', 'utf8'),
                    writeFile(join(app, 'Contents', 'MacOS', 'Caxri'), 'binary', 'utf8'),
                ]);
                return success();
            }
            if (command === 'hdiutil') return success('VALID\n');
            if (command === 'plutil') return success('0.0.7\n');
            if (command === 'lipo') return success('arm64\n');
            if (command === 'file') return success('zlib compressed data\n');
            if (command === 'codesign' && arguments_[0] === '-dv') {
                return success('', 'Signature=adhoc\nTeamIdentifier=not set\n');
            }
            if (command === 'codesign') {
                return { exitCode: 1, stderr: 'unsigned bundle', stdout: '' };
            }
            throw new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`);
        },
    };
    return { calls, executor };
}

describe('local DMG packaging', () => {
    it('restores exact manifests and reports bounded artifact verification', async () => {
        const { cwd, lockSource, packageSource } = await fixture();
        const { calls, executor } = fakeExecutor(cwd);

        const result = await packageLocalDmg(
            { allowDirty: false, cwd, version: '0.0.7' },
            executor,
            '2026-08-11T02:00:00Z',
        );

        expect(result).toMatchObject({
            architecture: ['arm64'],
            codeSigning: {
                inspectionPassed: true,
                signature: 'adhoc',
                strictVerificationDetail: 'unsigned bundle',
                strictVerificationPassed: false,
                teamIdentifier: 'not set',
            },
            originalSourceVersion: '0.0.6',
            source: { dirtyAllowed: false, headSha: 'head-sha' },
            verifiedAt: '2026-08-11T02:00:00Z',
            version: '0.0.7',
        });
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(await readFile(join(cwd, 'package.json'), 'utf8')).toBe(packageSource);
        expect(await readFile(join(cwd, 'pnpm-lock.yaml'), 'utf8')).toBe(lockSource);
        expect(calls).toContain('pnpm version 0.0.7 --no-git-tag-version --no-git-checks');
        expect(calls).toContain('bun run package:dmg');
    });

    it('restores exact manifests when electron-builder fails', async () => {
        const { cwd, lockSource, packageSource } = await fixture();
        const { executor } = fakeExecutor(cwd, true);

        await expect(
            packageLocalDmg({ allowDirty: false, cwd, version: '0.0.7' }, executor),
        ).rejects.toThrow('builder failed');
        expect(await readFile(join(cwd, 'package.json'), 'utf8')).toBe(packageSource);
        expect(await readFile(join(cwd, 'pnpm-lock.yaml'), 'utf8')).toBe(lockSource);
    });

    it('requires explicit dirty-source packaging and valid SemVer input', async () => {
        expect(() => parseLocalDmgArguments(['--version', 'version-seven'])).toThrow('SemVer');
        expect(() => parseLocalDmgArguments([])).toThrow('Missing --version');
        expect(parseLocalDmgArguments(['--version', '0.0.7', '--allow-dirty'])).toMatchObject({
            allowDirty: true,
            version: '0.0.7',
        });

        const { cwd } = await fixture();
        const { executor } = fakeExecutor(cwd);
        const dirtyExecutor: CommandExecutor = {
            async run(command, arguments_, options) {
                if (
                    command === 'git' &&
                    arguments_[0] === 'status' &&
                    arguments_.includes('--untracked-files=all')
                ) {
                    return success(' M src/example.ts\n');
                }
                return executor.run(command, arguments_, options);
            },
        };
        await expect(
            packageLocalDmg({ allowDirty: false, cwd, version: '0.0.7' }, dirtyExecutor),
        ).rejects.toThrow('dirty worktree');
    });
});
