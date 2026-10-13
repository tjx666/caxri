import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const rootRequire = createRequire(join(import.meta.dirname, '../../package.json'));
const mobileRequire = createRequire(join(import.meta.dirname, '../../apps/mobile/package.json'));
const reactNativeRequire = createRequire(mobileRequire.resolve('react-native/package.json'));
const reactDevtoolsRequire = createRequire(
    reactNativeRequire.resolve('react-devtools-core/package.json'),
);
const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
const expoCliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const forgeRequire = createRequire(expoCliRequire.resolve('node-forge/package.json'));
const expoCertificatesRequire = createRequire(
    expoCliRequire.resolve('@expo/code-signing-certificates/package.json'),
);
const expoMetroRequire = createRequire(expoCliRequire.resolve('@expo/metro/package.json'));
const metroFileMapRequire = createRequire(expoMetroRequire.resolve('metro-file-map/package.json'));
const micromatchRequire = createRequire(metroFileMapRequire.resolve('micromatch/package.json'));
const bracesRequire = createRequire(micromatchRequire.resolve('braces/package.json'));
const markdownlintRequire = createRequire(rootRequire.resolve('markdownlint-cli2'));
const globbyRequire = createRequire(markdownlintRequire.resolve('globby'));
const fastGlobRequire = createRequire(globbyRequire.resolve('fast-glob'));

interface ShellQuote {
    parse(value: string): Array<string | { comment: string }>;
    quote(values: Array<string | { comment: string }>): string;
}

interface ForgeDigest {
    digest(): { getBytes(): string };
    update(value: string): void;
}

interface ForgePublicKey {
    verify(
        digest: string,
        signature: string,
        scheme?: unknown,
        options?: Record<string, boolean>,
    ): boolean;
}

interface ExpoCertificateApi {
    generateKeyPair(): {
        privateKey: unknown;
        publicKey: unknown;
    };
    generateSelfSignedCodeSigningCertificate(options: {
        commonName: string;
        keyPair: { privateKey: unknown; publicKey: unknown };
        validityNotAfter: Date;
        validityNotBefore: Date;
    }): unknown;
    signBufferRSASHA256AndVerify(privateKey: unknown, certificate: unknown, buffer: Buffer): string;
    validateSelfSignedCertificate(
        certificate: unknown,
        keyPair: { privateKey: unknown; publicKey: unknown },
    ): void;
}

const shellQuote = reactDevtoolsRequire('shell-quote') as ShellQuote;
const shellQuotePackage = reactDevtoolsRequire('shell-quote/package.json') as { version: string };
const braces = bracesRequire('.') as (pattern: string) => string[];
const bracesPackage = bracesRequire('./package.json') as { version: string };
const fastGlob = fastGlobRequire('.') as {
    sync(pattern: string | string[], options: { cwd: string }): string[];
};
const fastGlobPattern = fastGlobRequire('./utils/pattern.js') as {
    expandBraceExpansion(pattern: string): string[];
};
const forgePackage = forgeRequire('./package.json') as { version: string };
const ForgeJsbn = forgeRequire('./lib/jsbn') as {
    BigInteger: new (value: string, radix?: number) => unknown;
};
const ForgeMd = forgeRequire('./lib/md.all') as {
    sha256: { create(): ForgeDigest };
};
const ForgeRsa = forgeRequire('./lib/rsa') as {
    setPublicKey(modulus: unknown, exponent: unknown): ForgePublicKey;
};
const ForgeUtility = forgeRequire('./lib/util') as {
    binary: { hex: { decode(value: string): string } };
};
const expoCertificates = expoCertificatesRequire('.') as ExpoCertificateApi;

const markdownFixture = mkdtempSync(join(tmpdir(), 'caxri-dependency-security-'));

afterAll(() => rmSync(markdownFixture, { force: true, recursive: true }));

describe('dependency security patches', () => {
    it('keeps React DevTools editor parsing on the first safe shell-quote release', () => {
        expect(shellQuotePackage.version).toBe('1.11.0');
        expect(shellQuote.parse('code')).toEqual(['code']);
        expect(shellQuote.parse('code --wait')).toEqual(['code', '--wait']);
        expect(
            shellQuote.parse(
                '"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --wait',
            ),
        ).toEqual([
            '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
            '--wait',
        ]);
        expect(shellQuote.parse(String.raw`code --wait file\ with\ spaces.ts`)).toEqual([
            'code',
            '--wait',
            'file with spaces.ts',
        ]);
        expect(() => shellQuote.quote(['echo', 'ok', { comment: 'comment' }, 'a\nid;#'])).toThrow(
            TypeError,
        );
    });

    it('rejects the nested DigestAlgorithm signature forgery from GHSA-86w9-cpqp-85rv', () => {
        expect(forgePackage.version).toBe('1.4.0');
        const modulus = new ForgeJsbn.BigInteger(
            'E932AC92252F585B3A80A4DD76A897C8B7652952FE788F6EC8DD640587A1EE56' +
                '47670A8AD4C2BE0F9FA6E49C605ADF77B5174230AF7BD50E5D6D6D6D28CCF0A8' +
                '86A514CC72E51D209CC772A52EF419F6A953F3135929588EBE9B351FCA61CED7' +
                '8F346FE00DBB6306E5C2A4C6DFC3779AF85AB417371CF34D8387B9B30AE46D7A' +
                '5FF5A655B8D8455F1B94AE736989D60A6F2FD5CADBFFBD504C5A756A2E6BB5CE' +
                'CC13BCA7503F6DF8B52ACE5C410997E98809DB4DC30D943DE4E812A47553DCE5' +
                '4844A78E36401D13F77DC650619FED88D8B3926E3D8E319C80C744779AC5D6AB' +
                'E252896950917476ECE5E8FC27D5F053D6018D91B502C4787558A002B9283DA7',
            16,
        );
        const publicKey = ForgeRsa.setPublicKey(modulus, new ForgeJsbn.BigInteger('3'));
        const signature = ForgeUtility.binary.hex.decode(
            'a4ae63dd5e7712b78f4870d0f51e294df5503d4f16c5d27ae33370981fb57f0de49f' +
                '50f3d6a04666774cd984cd13972db9bf8e12bd294ef0ddc916c7c86cbae63efd7b6b' +
                '97885e69760c208a40f1aecc76a90d7af5145177efce1bb55807a8d05c20b1596753' +
                'ba710642fc9acdde6c160232654662c77cc4466c8257a38edb49f894e8845d0fd987' +
                'b857ced88f4b62505a080bd87ef700d35d392a6e8f6fde34250c50b86fae606cb551' +
                '215e8f4813239b77651d5565ad453698c071d48c31e8e526fb4a37610f64b3e1fb8e' +
                '5be5898e408ad08197a0947794a530b54f84485377ce4a7488ed485ce4e5e105dd89' +
                '698a472f390c3b1b76bc16b73276c4d1c81d',
        );
        const digest = ForgeMd.sha256.create();
        digest.update('hello world!');

        expect(() =>
            publicKey.verify(digest.digest().getBytes(), signature, undefined, {
                _parseAllDigestBytes: true,
                _skipPaddingChecks: true,
            }),
        ).toThrow('ASN.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value');
    });

    it('preserves Expo code-signing certificate and signature verification', () => {
        const keyPair = expoCertificates.generateKeyPair();
        const certificate = expoCertificates.generateSelfSignedCodeSigningCertificate({
            commonName: 'Caxri dependency security fixture',
            keyPair,
            validityNotAfter: new Date(Date.now() + 86_400_000),
            validityNotBefore: new Date(Date.now() - 86_400_000),
        });

        expect(() =>
            expoCertificates.validateSelfSignedCertificate(certificate, keyPair),
        ).not.toThrow();
        expect(
            expoCertificates.signBufferRSASHA256AndVerify(
                keyPair.privateKey,
                certificate,
                Buffer.from('public dependency security fixture'),
            ),
        ).toMatch(/^[A-Z\d+/]+=*$/i);
    });

    it('bounds braces recursion while preserving common fast-glob expansions', () => {
        expect(bracesPackage.version).toBe('3.0.3');
        const atLimit = `${'{'.repeat(100)}a,b${'}'.repeat(100)}`;
        const aboveLimit = `${'{'.repeat(101)}a,b${'}'.repeat(101)}`;

        expect(() => braces(atLimit)).not.toThrow();
        expect(() => braces(aboveLimit)).toThrow(/exceeds max depth/);
        expect(fastGlobPattern.expandBraceExpansion('{a,b}')).toEqual(['a', 'b']);
        expect(fastGlobPattern.expandBraceExpansion('a/{b,}/{c,}/*')).toEqual([
            'a///*',
            'a/b//*',
            'a//c/*',
            'a/b/c/*',
        ]);
        expect(fastGlobPattern.expandBraceExpansion('{a,}')).toEqual(['a']);
    });

    it('preserves Markdown file matching through fast-glob', () => {
        mkdirSync(join(markdownFixture, 'docs'));
        writeFileSync(join(markdownFixture, 'README.md'), '# Fixture\n');
        writeFileSync(join(markdownFixture, 'docs', 'guide.md'), '# Guide\n');
        writeFileSync(join(markdownFixture, 'notes.txt'), 'not markdown\n');

        expect(
            fastGlob
                .sync('{README,docs/*}.md', { cwd: markdownFixture })
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['docs/guide.md', 'README.md']);
    });
});
