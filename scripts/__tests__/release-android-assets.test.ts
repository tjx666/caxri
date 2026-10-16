import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
    await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
) as {
    jobs: {
        release: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> };
    };
};

function step(name: string) {
    const result = workflow.jobs.release.steps.find((entry) => entry.name === name);
    if (!result?.run) throw new Error(`Missing release step: ${name}`);
    return result;
}

describe('Android Release assets', () => {
    let directory: string;
    const version = '0.0.123';
    const apk = `release.noindex/mobile/Caxri-Mobile-${version}-android-arm64.apk`;
    const source = Buffer.from('synthetic Android package');

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-release-assets-'));
        await mkdir(join(directory, 'bin'), { recursive: true });
        await writeFile(join(directory, 'bin/hdiutil'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await writeFile(join(directory, 'package.json'), JSON.stringify({ version }, undefined, 4));
        await writeFile(join(directory, 'outputs'), '');
        await Promise.all(
            ['sourcemap', 'nosourcemap'].map(async (flavor) => {
                const name = `Caxri-${version}-arm64${flavor === 'nosourcemap' ? '-nosourcemap' : ''}.dmg`;
                await mkdir(join(directory, 'release.noindex', flavor), { recursive: true });
                await writeFile(
                    join(directory, 'release.noindex', flavor, name),
                    'synthetic disk image',
                );
                const hash = createHash('sha256').update('synthetic disk image').digest('hex');
                await writeFile(
                    join(directory, 'release.noindex', flavor, `${name}.sha256`),
                    `${hash}  ${name}\n`,
                );
            }),
        );
        await mkdir(join(directory, 'out/mobile-update'), { recursive: true });
        await writeFile(join(directory, 'out/mobile-update/caxri-mobile.apk'), source);
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    function run(script: string, environment: Record<string, string> = {}) {
        return spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', script], {
            cwd: directory,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`,
                GITHUB_OUTPUT: join(directory, 'outputs'),
                ...environment,
            },
        });
    }

    it('stages the exact Desktop APK with a portable, verified SHA-256 companion', async () => {
        const result = run(step('Verify release artifact').run!);
        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(join(directory, apk))).toEqual(source);
        const hash = createHash('sha256').update(source).digest('hex');
        expect(await readFile(join(directory, `${apk}.sha256`), 'utf8')).toBe(
            `${hash}  Caxri-Mobile-${version}-android-arm64.apk\n`,
        );
        expect(await readFile(join(directory, 'outputs'), 'utf8')).toContain(`android=${apk}\n`);
        expect(await readFile(join(directory, 'outputs'), 'utf8')).toContain(
            `android_checksum=${apk}.sha256\n`,
        );
        await writeFile(join(directory, apk), 'corrupted download');
        expect(
            run(
                `cd release.noindex/mobile && shasum -a 256 -c Caxri-Mobile-${version}-android-arm64.apk.sha256`,
            ).status,
        ).not.toBe(0);
    });

    it('refuses to publish an incomplete asset set when the Android APK is missing', async () => {
        await rm(join(directory, 'out/mobile-update/caxri-mobile.apk'));
        expect(run(step('Verify release artifact').run!).status).not.toBe(0);
    });

    it('passes the APK and checksum to GitHub with Android installation instructions', async () => {
        await writeFile(
            join(directory, 'bin/gh'),
            '#!/bin/sh\nprintf "%s\\0" "$@" > "$CAXRI_TEST_ARGUMENTS"\n',
            { mode: 0o755 },
        );
        const publication = step('Create GitHub Release');
        expect(publication.env?.RELEASE_ANDROID_APK).toBe('${{ steps.artifact.outputs.android }}');
        expect(publication.env?.RELEASE_ANDROID_CHECKSUM).toBe(
            '${{ steps.artifact.outputs.android_checksum }}',
        );
        const result = run(publication.run!, {
            CAXRI_TEST_ARGUMENTS: join(directory, 'arguments'),
            RELEASE_TAG: `v${version}`,
            RELEASE_TARGET_SHA: 'synthetic-commit',
            RELEASE_SOURCEMAP_DMG: 'source.dmg',
            RELEASE_SOURCEMAP_CHECKSUM: 'source.dmg.sha256',
            RELEASE_NOSOURCEMAP_DMG: 'smaller.dmg',
            RELEASE_NOSOURCEMAP_CHECKSUM: 'smaller.dmg.sha256',
            RELEASE_ANDROID_APK: apk,
            RELEASE_ANDROID_CHECKSUM: `${apk}.sha256`,
        });
        expect(result.status, result.stderr).toBe(0);
        const arguments_ = (await readFile(join(directory, 'arguments'), 'utf8')).split('\0');
        expect(arguments_).toContain(apk);
        expect(arguments_).toContain(`${apk}.sha256`);
        const notes = arguments_[arguments_.indexOf('--notes') + 1];
        expect(notes).toContain(`Caxri-Mobile-${version}-android-arm64.apk`);
        expect(notes).toContain('Allow from this source');
        expect(notes).toContain('iOS');
    });
});
