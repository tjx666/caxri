#!/usr/bin/env bun
/**
 * Prepares the macOS code signing identity for release packaging on a GitHub-hosted runner, then exports
 * `CAXRI_MAC_SIGNING_IDENTITY` and `CAXRI_MAC_SIGNING_CERT_SHA1` through `$GITHUB_ENV` for
 * `scripts/package-release-dmgs.ts`, `scripts/electron-builder-mac-sign.ts`, and `scripts/build-share-extension.ts`.
 *
 * - `release` imports the long-lived self-signed release certificate from `CAXRI_MAC_SIGNING_P12_BASE64` and
 *   `CAXRI_MAC_SIGNING_P12_PASSWORD`, and fails unless its SHA-1 equals `CAXRI_MAC_SIGNING_EXPECTED_CERT_SHA1`: a
 *   different certificate would ship a new designated requirement and drop every user's macOS privacy grants.
 * - `ephemeral` generates a throwaway self-signed certificate so the no-publish rehearsal exercises the same signing path
 *   without holding publication credentials.
 * - `cleanup` deletes the temporary keychain.
 *
 * The identity lives in its own keychain with a random password; nothing is written to the login keychain, and the
 * private key never leaves `$RUNNER_TEMP`. See RELEASING.md#release-signing-certificate.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';

const KEYCHAIN_NAME = 'caxri-release-signing.keychain-db';
const EPHEMERAL_IDENTITY = 'Caxri Rehearsal Signing';

interface CodeSigningIdentity {
    name: string;
    sha1: string;
}

/**
 * Parses `security find-identity -p codesigning <keychain>`. A self-signed certificate is reported as
 * `CSSMERR_TP_NOT_TRUSTED`, which `codesign` still accepts, so the listing is read without `-v`.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/import-mac-signing-identity.test.ts
export function parseCodeSigningIdentities(output: string): CodeSigningIdentity[] {
    const identities = new Map<string, CodeSigningIdentity>();
    for (const match of output.matchAll(/^\s*\d+\)\s+([\dA-F]{40})\s+"([^"]+)"/gm)) {
        const [, sha1, name] = match;
        identities.set(sha1, { name, sha1 });
    }
    return identities.values().toArray();
}

/**
 * Returns the single identity the temporary keychain holds and, for the release certificate, proves it is the pinned
 * one.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/import-mac-signing-identity.test.ts
export function selectSigningIdentity(
    identities: readonly CodeSigningIdentity[],
    expectedSha1?: string,
): CodeSigningIdentity {
    if (identities.length !== 1)
        throw new Error(`Expected one code signing identity, found ${identities.length}.`);
    const [identity] = identities;
    if (expectedSha1 !== undefined && identity.sha1 !== expectedSha1.trim().toUpperCase())
        throw new Error(
            `The release signing certificate ${identity.sha1} is not the pinned certificate ${expectedSha1}.`,
        );
    return identity;
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
}

function keychainPath(): string {
    return join(requiredEnvironment('RUNNER_TEMP'), KEYCHAIN_NAME);
}

async function security(arguments_: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync('security', arguments_);
    return stdout;
}

/**
 * Generates a short-lived self-signed code signing certificate. macOS ships LibreSSL, which has no `-legacy` flag but
 * already writes the PKCS#12 algorithms `security import` accepts.
 */
async function writeEphemeralIdentity(directory: string, password: string): Promise<string> {
    const config = join(directory, 'identity.cnf');
    const key = join(directory, 'key.pem');
    const certificate = join(directory, 'certificate.pem');
    const p12 = join(directory, 'identity.p12');
    await writeFile(
        config,
        [
            '[req]',
            'distinguished_name=dn',
            'x509_extensions=v3',
            'prompt=no',
            '[dn]',
            `CN=${EPHEMERAL_IDENTITY}`,
            '[v3]',
            'basicConstraints=critical,CA:false',
            'keyUsage=critical,digitalSignature',
            'extendedKeyUsage=critical,codeSigning',
            '',
        ].join('\n'),
    );
    await execFileAsync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        config,
        '-keyout',
        key,
        '-out',
        certificate,
    ]);
    await execFileAsync('openssl', [
        'pkcs12',
        '-export',
        '-inkey',
        key,
        '-in',
        certificate,
        '-out',
        p12,
        '-passout',
        `pass:${password}`,
    ]);
    return p12;
}

async function importIdentity(mode: 'ephemeral' | 'release'): Promise<void> {
    const keychain = keychainPath();
    const keychainPassword = randomBytes(24).toString('hex');
    const work = await mkdtemp(join(requiredEnvironment('RUNNER_TEMP'), 'caxri-signing-'));
    try {
        let p12: string;
        let p12Password: string;
        if (mode === 'release') {
            p12 = join(work, 'identity.p12');
            p12Password = requiredEnvironment('CAXRI_MAC_SIGNING_P12_PASSWORD');
            await writeFile(
                p12,
                Buffer.from(requiredEnvironment('CAXRI_MAC_SIGNING_P12_BASE64'), 'base64'),
                { mode: 0o600 },
            );
        } else {
            p12Password = randomBytes(24).toString('hex');
            p12 = await writeEphemeralIdentity(work, p12Password);
        }

        await security(['create-keychain', '-p', keychainPassword, keychain]);
        await security(['set-keychain-settings', keychain]);
        await security(['unlock-keychain', '-p', keychainPassword, keychain]);
        await security([
            'import',
            p12,
            '-k',
            keychain,
            '-P',
            p12Password,
            '-T',
            '/usr/bin/codesign',
        ]);
        // Lets codesign use the private key without a GUI access prompt.
        await security([
            'set-key-partition-list',
            '-S',
            'apple-tool:,apple:',
            '-s',
            '-k',
            keychainPassword,
            keychain,
        ]);
        // codesign and @electron/osx-sign locate the identity through the user search list.
        const searchList = (await security(['list-keychains', '-d', 'user']))
            .split('\n')
            .map((line) => line.trim().replaceAll('"', ''))
            .filter(Boolean);
        await security(['list-keychains', '-d', 'user', '-s', keychain, ...searchList]);

        const identity = selectSigningIdentity(
            parseCodeSigningIdentities(
                await security(['find-identity', '-p', 'codesigning', keychain]),
            ),
            mode === 'release'
                ? requiredEnvironment('CAXRI_MAC_SIGNING_EXPECTED_CERT_SHA1')
                : undefined,
        );
        await appendFile(
            requiredEnvironment('GITHUB_ENV'),
            `CAXRI_MAC_SIGNING_IDENTITY=${identity.name}\nCAXRI_MAC_SIGNING_CERT_SHA1=${identity.sha1}\n`,
        );
        console.log(`Imported code signing identity "${identity.name}" (${identity.sha1}).`);
    } finally {
        await rm(work, { force: true, recursive: true });
    }
}

async function cleanup(): Promise<void> {
    try {
        await execFileAsync('security', ['delete-keychain', keychainPath()]);
    } catch {
        // The keychain is absent when the import step failed before creating it.
    }
}

if (import.meta.main) {
    const mode = process.argv[2];
    if (mode === 'release' || mode === 'ephemeral') await importIdentity(mode);
    else if (mode === 'cleanup') await cleanup();
    else throw new Error('Usage: import-mac-signing-identity.ts <release|ephemeral|cleanup>');
}
