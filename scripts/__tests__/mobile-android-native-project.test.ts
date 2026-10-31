import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    ANDROID_PREBUILD_INPUT_PATHS,
    androidPrebuildInputFingerprint,
    decideAndroidPrebuild,
    hashAndroidNativeProject,
    parseAndroidEmulatorAbi,
    readAndroidPrebuildStamp,
    writeAndroidPrebuildStamp,
} from '../mobile-android-native-project';

const repoRoot = resolve(import.meta.dirname, '../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function createNativeProject(): Promise<string> {
    const android = await mkdtemp(join(tmpdir(), 'caxri-android-project-'));
    temporaryDirectories.push(android);
    await mkdir(join(android, 'app/build/outputs'), { recursive: true });
    await mkdir(join(android, '.gradle/9.4.1'), { recursive: true });
    await writeFile(join(android, 'gradle.properties'), 'org.gradle.caching=true\n');
    await writeFile(join(android, 'app/build.gradle'), 'android {}\n');
    await writeFile(join(android, 'app/build/outputs/app-release.apk'), 'apk');
    await writeFile(join(android, '.gradle/9.4.1/executionHistory.bin'), 'history');
    return android;
}

describe('Android prebuild reuse', () => {
    it('reuses the native project only while its inputs and generated sources are unchanged', async () => {
        const android = await createNativeProject();
        const inputs = androidPrebuildInputFingerprint((path) => `object-of-${path}`);
        await writeAndroidPrebuildStamp(android, inputs);
        const stamp = await readAndroidPrebuildStamp(android);
        const project = await hashAndroidNativeProject(android);

        expect(decideAndroidPrebuild(stamp, { inputs, project })).toEqual({ action: 'reuse' });

        // Gradle state and build outputs change on every build without touching the generated project.
        await writeFile(join(android, 'app/build/outputs/app-release.apk'), 'rebuilt apk');
        await writeFile(join(android, '.gradle/9.4.1/executionHistory.bin'), 'more history');
        expect(await hashAndroidNativeProject(android)).toBe(project);

        const changedInputs = androidPrebuildInputFingerprint((path) =>
            path === 'apps/mobile/plugins' ? 'edited-plugins' : `object-of-${path}`,
        );
        expect(decideAndroidPrebuild(stamp, { inputs: changedInputs, project })).toEqual({
            action: 'regenerate',
            reason: 'inputs-changed',
        });

        await writeFile(join(android, 'app/build.gradle'), 'android { edited }\n');
        expect(
            decideAndroidPrebuild(stamp, {
                inputs,
                project: await hashAndroidNativeProject(android),
            }),
        ).toEqual({ action: 'regenerate', reason: 'project-modified' });
    });

    it('regenerates a project without a valid stamp', async () => {
        const android = await createNativeProject();
        await writeFile(join(android, '.caxri-prebuild.json'), '{"schemaVersion":0}');

        expect(
            decideAndroidPrebuild(await readAndroidPrebuildStamp(android), {
                inputs: 'inputs',
                project: 'project',
            }),
        ).toEqual({ action: 'regenerate', reason: 'stamp-missing' });
        expect(decideAndroidPrebuild(undefined, { inputs: 'inputs', project: undefined })).toEqual({
            action: 'regenerate',
            reason: 'stamp-missing',
        });
    });

    it('covers every repository file the app config and its plugins import', async () => {
        const mobileRoot = join(repoRoot, 'apps/mobile');
        const plugins = (await readdir(join(mobileRoot, 'plugins')))
            .filter((name) => name.endsWith('.ts'))
            .map((name) => join(mobileRoot, 'plugins', name));
        const covered = (path: string) =>
            ANDROID_PREBUILD_INPUT_PATHS.some(
                (input) => path === input || path.startsWith(`${input}/`),
            );
        for (const file of [join(mobileRoot, 'app.config.ts'), ...plugins]) {
            // eslint-disable-next-line no-await-in-loop -- a handful of small source files.
            const source = await readFile(file, 'utf8');
            const references = [
                ...source.matchAll(/from '(\.[^']+)'/gu),
                ...source.matchAll(/'(\.\.?\/[^']+\.(?:png|json))'/gu),
            ].map((match) => relative(repoRoot, resolve(dirname(file), match[1])));
            for (const reference of references)
                expect(covered(reference), `${relative(repoRoot, file)} reads ${reference}`).toBe(
                    true,
                );
        }
    });
});

describe('parseAndroidEmulatorAbi', () => {
    it('accepts the two emulator ABIs the release build can target', () => {
        expect(parseAndroidEmulatorAbi('arm64-v8a\r\n')).toBe('arm64-v8a');
        expect(parseAndroidEmulatorAbi('x86_64\n')).toBe('x86_64');
        expect(() => parseAndroidEmulatorAbi('armeabi-v7a')).toThrow();
    });
});
