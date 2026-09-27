#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';

import type { MobileUpdateBundle } from '@caxri/protocol';
import {
    MOBILE_UPDATE_APK_FILE,
    MOBILE_UPDATE_MANIFEST_FILE,
    mobileUpdateBundleSchema,
} from '@caxri/protocol';

import { mobileVersionCode } from '../app.config';
import mobilePackage from '../package.json';
import { ANDROID_RELEASE_SIGNING_ENVIRONMENT } from '../plugins/with-android-release-signing';
import { resolveAndroidToolchain } from './android-toolchain';
import {
    assertUpdateApkIdentity,
    parseApkBadging,
    parseApkSignerDigests,
    parseKeytoolDigest,
    readReleaseSigning,
} from './update-bundle-receipts';

/**
 * Builds the arm64 release APK and stages it where electron-builder copies `Resources/mobile` from. Desktop serves this
 * bundle to paired phones, so the script fails instead of staging anything it cannot prove is the release-signed build
 * of the current version.
 */
const signing = readReleaseSigning(process.env);
if (!existsSync(signing.keystorePath))
    throw new Error(`${ANDROID_RELEASE_SIGNING_ENVIRONMENT.keystorePath} does not name a file`);
const toolchain = resolveAndroidToolchain();
const outputDirectory = join(toolchain.mobileRoot, '..', '..', 'out', 'mobile-update');
const toolEnvironment = {
    ...process.env,
    JAVA_HOME: toolchain.javaHome,
    PATH: `${join(toolchain.javaHome, 'bin')}:${process.env.PATH ?? ''}`,
};

const run = (command: string, arguments_: string[], options: { capture?: boolean } = {}) => {
    const result = spawnSync(command, arguments_, {
        cwd: toolchain.mobileRoot,
        encoding: 'utf8',
        env: toolEnvironment,
        shell: false,
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${command} ${arguments_[0] ?? ''} exited with ${String(result.status)}`);
    return result.stdout;
};

const md5 = async (path: string): Promise<string> => {
    const hash = createHash('md5');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
};

await rm(outputDirectory, { force: true, recursive: true });
run('bun', ['run', 'prebuild:android', '--', '--clean']);
run('bun', [
    'run',
    'android',
    '--',
    '--build-only',
    '--variant',
    'release',
    '--abi',
    'arm64-v8a',
    '--optimize',
]);

const apkPath = join(toolchain.mobileRoot, 'android/app/build/outputs/apk/release/app-release.apk');
const badging = run(join(toolchain.appBuildToolsPath, 'aapt2'), ['dump', 'badging', apkPath], {
    capture: true,
});
const certificate = run(
    join(toolchain.javaHome, 'bin', 'keytool'),
    [
        '-list',
        '-v',
        '-keystore',
        signing.keystorePath,
        '-alias',
        signing.keyAlias,
        '-storepass:env',
        ANDROID_RELEASE_SIGNING_ENVIRONMENT.keystorePassword,
    ],
    { capture: true },
);
const signers = run(
    join(toolchain.appBuildToolsPath, 'apksigner'),
    ['verify', '--print-certs', apkPath],
    { capture: true },
);
assertUpdateApkIdentity({
    badging: parseApkBadging(badging),
    expectedVersion: mobilePackage.version,
    expectedVersionCode: mobileVersionCode(mobilePackage.version),
    releaseDigest: parseKeytoolDigest(certificate),
    signerDigests: parseApkSignerDigests(signers),
});

await mkdir(outputDirectory, { recursive: true });
const stagedApk = join(outputDirectory, MOBILE_UPDATE_APK_FILE);
await copyFile(apkPath, stagedApk);
const bundle: MobileUpdateBundle = mobileUpdateBundleSchema.parse({
    version: mobilePackage.version,
    versionCode: mobileVersionCode(mobilePackage.version),
    sizeBytes: (await stat(stagedApk)).size,
    md5: await md5(stagedApk),
});
await writeFile(
    join(outputDirectory, MOBILE_UPDATE_MANIFEST_FILE),
    `${JSON.stringify(bundle, undefined, 4)}\n`,
);
console.log(JSON.stringify({ outputDirectory, ...bundle }));
