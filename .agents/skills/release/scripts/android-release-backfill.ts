#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import ANDROID_RELEASE_SIGNING_ENVIRONMENT from '../../../../apps/mobile/plugins/android-release-signing-environment.json';
import {
    assertUpdateApkIdentity,
    parseApkBadging,
    parseApkSignerDigests,
    parseKeytoolDigest,
    readReleaseSigning,
} from '../../../../apps/mobile/scripts/update-bundle-receipts';

const execFileAsync = promisify(execFile);

// eslint-disable-next-line unicorn/no-exports-in-scripts -- shared with the focused backfill tests
export type BackfillCommand = (command: string, arguments_: string[]) => Promise<string>;

interface PublishedRelease {
    id: number;
    tag_name: string;
    draft: boolean;
    published_at: string | null;
    body: string | null;
    assets: Array<{ name: string }>;
}

interface AndroidBackfillTarget {
    tag: string;
    sha: string;
    releaseId: number;
}

function releaseVersion(tag: string): string {
    if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag)) {
        throw new Error('Android backfill requires an exact stable release tag');
    }
    return tag.slice(1);
}

function apkName(tag: string): string {
    return `Caxri-Mobile-${releaseVersion(tag)}-android-arm64.apk`;
}

async function publishedRelease(
    repo: string,
    tag: string,
    run: BackfillCommand,
): Promise<PublishedRelease> {
    releaseVersion(tag);
    const release = JSON.parse(
        await run('gh', ['api', `repos/${repo}/releases/tags/${tag}`]),
    ) as PublishedRelease;
    if (release.tag_name !== tag || release.draft || !release.published_at || !release.id) {
        throw new Error('Android backfill requires an existing published Release');
    }
    const names = new Set(release.assets.map(({ name }) => name));
    if (!names.has(`Caxri-${releaseVersion(tag)}-arm64.dmg`)) {
        throw new Error('The published Desktop release asset is missing');
    }
    return release;
}

/**
 * Resolves an already published release before the job exposes signing secrets to its pinned source.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- exercised by the focused backfill integration tests
export async function resolveAndroidBackfill(
    repo: string,
    tag: string,
    run: BackfillCommand,
): Promise<AndroidBackfillTarget> {
    const release = await publishedRelease(repo, tag, run);
    const sha = (await run('git', ['rev-parse', '--verify', `refs/tags/${tag}^0`])).trim();
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('Invalid release commit');
    await run('git', ['merge-base', '--is-ancestor', sha, 'HEAD']);
    const subject = (await run('git', ['show', '-s', '--format=%s', sha])).trim();
    const manifest = JSON.parse(await run('git', ['show', `${sha}:package.json`])) as {
        version?: string;
    };
    if (subject !== `release: ${tag}` || manifest.version !== releaseVersion(tag)) {
        throw new Error('Release tag, commit subject and package version must match');
    }
    return { tag, sha, releaseId: release.id };
}

/**
 * Checks the staged bundle again after the existing builder verifies APK identity and release-key signatures.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- exercised by the focused backfill integration tests
export async function stageAndroidBackfill(cwd: string, tag: string): Promise<string> {
    const version = releaseVersion(tag);
    const bundleDirectory = join(cwd, 'out/mobile-update');
    const apk = await readFile(join(bundleDirectory, 'caxri-mobile.apk'));
    const manifest = JSON.parse(await readFile(join(bundleDirectory, 'manifest.json'), 'utf8')) as {
        version?: string;
        versionCode?: number;
        sizeBytes?: number;
        md5?: string;
    };
    const [major, minor, patch] = version.split('.').map(Number);
    const versionCode = major! * 1_000_000 + minor! * 1_000 + patch!;
    if (
        manifest.version !== version ||
        manifest.versionCode !== versionCode ||
        apk.length === 0 ||
        manifest.sizeBytes !== apk.length ||
        manifest.md5 !== createHash('md5').update(apk).digest('hex')
    ) {
        throw new Error('Android update bundle version or integrity does not match the Release');
    }
    const directory = join(cwd, 'release.noindex/mobile');
    const name = apkName(tag);
    await mkdir(directory, { recursive: true });
    const path = join(directory, name);
    await copyFile(join(bundleDirectory, 'caxri-mobile.apk'), path);
    const staged = await readFile(path);
    if (!apk.equals(staged)) throw new Error('Staged Android APK differs from the verified bundle');
    await writeFile(
        `${path}.sha256`,
        `${createHash('sha256').update(staged).digest('hex')}  ${name}\n`,
    );
    return path;
}

/**
 * Uses current trusted parsers and tools even when the selected historical tag has a weaker builder.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- exercised by the focused backfill integration tests
export async function verifyAndroidBackfill(
    cwd: string,
    tag: string,
    environment: NodeJS.ProcessEnv,
    run: BackfillCommand,
): Promise<string> {
    const signing = readReleaseSigning(environment);
    const sdk = environment.ANDROID_SDK_ROOT ?? environment.ANDROID_HOME;
    if (!sdk || !environment.JAVA_HOME) throw new Error('Android SDK and JAVA_HOME are required');
    const apk = await stageAndroidBackfill(cwd, tag);
    const tools = join(sdk, 'build-tools/36.0.0');
    const badging = await run(join(tools, 'aapt2'), ['dump', 'badging', apk]);
    if (!/^native-code: 'arm64-v8a'$/mu.test(badging))
        throw new Error('APK must contain only arm64-v8a native code');
    const signers = await run(join(tools, 'apksigner'), ['verify', '--print-certs', apk]);
    const certificate = await run(join(environment.JAVA_HOME, 'bin/keytool'), [
        '-list',
        '-v',
        '-keystore',
        signing.keystorePath,
        '-alias',
        signing.keyAlias,
        '-storepass:env',
        ANDROID_RELEASE_SIGNING_ENVIRONMENT.keystorePassword,
    ]);
    const manifest = JSON.parse(
        await readFile(join(cwd, 'out/mobile-update/manifest.json'), 'utf8'),
    ) as { versionCode: number };
    assertUpdateApkIdentity({
        badging: parseApkBadging(badging),
        expectedVersion: releaseVersion(tag),
        expectedVersionCode: manifest.versionCode,
        releaseDigest: parseKeytoolDigest(certificate),
        signerDigests: parseApkSignerDigests(signers),
    });
    return createHash('sha256')
        .update(await readFile(apk))
        .digest('hex');
}

/**
 * Rechecks remote identity after the build and appends assets without overwriting a published download.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- exercised by the focused backfill integration tests
export async function publishAndroidBackfill(
    cwd: string,
    repo: string,
    target: AndroidBackfillTarget,
    run: BackfillCommand,
    verifiedApkSha256: string,
): Promise<void> {
    const { tag, sha, releaseId } = target;
    const release = await publishedRelease(repo, tag, run);
    const remoteCommit = (
        await run('gh', ['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha'])
    ).trim();
    const checkoutCommit = (await run('git', ['rev-parse', 'HEAD'])).trim();
    if (remoteCommit !== sha || checkoutCommit !== sha || release.id !== releaseId) {
        throw new Error('Release or tag identity changed during the Android build');
    }
    const apk = await stageAndroidBackfill(cwd, tag);
    if (
        createHash('sha256')
            .update(await readFile(apk))
            .digest('hex') !== verifiedApkSha256
    ) {
        throw new Error('APK changed after trusted signature verification');
    }

    const existingNames = new Set(release.assets.map(({ name }) => name));
    const downloadDirectory = await mkdtemp(join(tmpdir(), 'caxri-android-existing-assets-'));
    try {
        const comparisons = await Promise.allSettled(
            [apk, `${apk}.sha256`]
                .filter((path) => existingNames.has(basename(path)))
                .map(async (path) => {
                    const name = basename(path);
                    await run('gh', [
                        'release',
                        'download',
                        tag,
                        '--repo',
                        repo,
                        '--pattern',
                        name,
                        '--dir',
                        downloadDirectory,
                    ]);
                    const [existing, staged] = await Promise.all([
                        readFile(join(downloadDirectory, name)),
                        readFile(path),
                    ]);
                    if (!existing.equals(staged))
                        throw new Error(
                            `Existing release asset conflicts with verified bytes: ${name}`,
                        );
                }),
        );
        const failed = comparisons.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
        for (const path of [apk, `${apk}.sha256`]) {
            if (existingNames.has(basename(path))) continue;
            // eslint-disable-next-line no-await-in-loop -- sequential writes allow an exact retry after partial upload failure
            await run('gh', ['release', 'upload', tag, path, '--repo', repo]);
        }
    } finally {
        await rm(downloadDirectory, { recursive: true, force: true });
    }

    const notesDirectory = await mkdtemp(join(tmpdir(), 'caxri-android-release-notes-'));
    try {
        const notesPath = join(notesDirectory, 'notes.md');
        const latest = JSON.parse(
            await run('gh', ['api', `repos/${repo}/releases/tags/${tag}`]),
        ) as PublishedRelease;
        if (latest.id !== releaseId)
            throw new Error('Release identity changed before updating notes');
        const marker = `<!-- caxri-android-backfill:${tag}:${sha} -->`;
        if (latest.body?.includes(marker)) return;
        const androidNotes = `## Android (arm64)

1. Download \`${apkName(tag)}\` from **Assets** on your Android phone.
2. Open the APK, enable **Allow from this source** for the browser or file manager if asked, then tap **Install**.
3. Open Caxri and pair from Desktop's **Settings > Mobile**. Use the same version on both devices.

This release-signed APK was rebuilt from the published tag \`${tag}\` (commit \`${sha}\`). It is provided separately for this existing release; the original DMGs are unchanged. Verify its accompanying \`.sha256\` file to check download integrity. Later release-signed APKs can update the app in place. Switching from a debug-signed development build requires uninstalling that build, which clears local app data and requires pairing again.

iOS installation packages are not distributed through GitHub Releases.
`;
        await writeFile(notesPath, `${latest.body ?? ''}\n\n${marker}\n${androidNotes}`);
        await run('gh', ['release', 'edit', tag, '--repo', repo, '--notes-file', notesPath]);
    } finally {
        await rm(notesDirectory, { force: true, recursive: true });
    }
}

if (import.meta.main) {
    const run: BackfillCommand = async (command, arguments_) => {
        const { stdout } = await execFileAsync(command, arguments_, { encoding: 'utf8' });
        return stdout;
    };
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('GITHUB_REPOSITORY is required');
    const [phase, tag, sha, releaseId, verifiedHash] = process.argv.slice(2);
    if (phase === 'resolve' && tag) {
        const target = await resolveAndroidBackfill(repo, tag, run);
        if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
        await appendFile(
            process.env.GITHUB_OUTPUT,
            `sha=${target.sha}\nrelease_id=${target.releaseId}\n`,
        );
    } else if (phase === 'verify' && tag) {
        const hash = await verifyAndroidBackfill(process.cwd(), tag, process.env, run);
        if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
        await appendFile(process.env.GITHUB_OUTPUT, `apk_sha256=${hash}\n`);
    } else if (phase === 'publish' && tag && sha && releaseId && verifiedHash) {
        await publishAndroidBackfill(
            process.cwd(),
            repo,
            { tag, sha, releaseId: Number(releaseId) },
            run,
            verifiedHash,
        );
    } else {
        throw new Error(
            'Usage: android-release-backfill.ts resolve TAG | verify TAG | publish TAG SHA RELEASE_ID APK_SHA256',
        );
    }
}
