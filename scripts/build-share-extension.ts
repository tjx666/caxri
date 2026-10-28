/**
 * Builds the macOS share extension (`apps/desktop/native/share-extension`) into `out/share-extension/Caxri
 * Share.appex`, which electron-builder copies into `Caxri.app/Contents/PlugIns` (`build.mac.extraFiles` in the root
 * `package.json`).
 *
 * The extension is compiled with `swiftc` for both Mac architectures and ad-hoc signed with its sandbox entitlements.
 * Release packaging runs with `CSC_IDENTITY_AUTO_DISCOVERY=false`, so electron-builder never re-signs it; a future
 * Developer ID build must sign the extension with these same entitlements. Other platforms skip the build: the
 * extension is a macOS packaging input only, and unpackaged development builds never contain it.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE_DIRECTORY = 'apps/desktop/native/share-extension';
const SHARE_EXTENSION_OUTPUT = 'out/share-extension/Caxri Share.appex';
const EXECUTABLE = 'CaxriShare';
const ARCHITECTURES = ['arm64', 'x86_64'] as const;
/**
 * Matches `LSMinimumSystemVersion` in the extension's `Info.plist`.
 */
const MINIMUM_MACOS = '14.0';

/**
 * The extension's `Info.plist` with its version placeholders filled from the app version, so the system reports the
 * extension and the app that contains it as the same build.
 */
export function shareExtensionInfoPlist(template: string, version: string): string {
    if (!/^\d+\.\d+\.\d+/.test(version))
        throw new Error(`Unexpected app version for share extension: ${version}`);
    return template.replaceAll('$(VERSION)', () => version);
}

async function buildShareExtension(repoRoot: string): Promise<void> {
    if (process.platform !== 'darwin') {
        console.log('share extension: skipped (macOS only)');
        return;
    }
    const source = join(repoRoot, SOURCE_DIRECTORY);
    const bundle = join(repoRoot, SHARE_EXTENSION_OUTPUT);
    const macOS = join(bundle, 'Contents', 'MacOS');
    const work = join(dirname(bundle), 'work');
    await rm(dirname(bundle), { force: true, recursive: true });
    await mkdir(macOS, { recursive: true });
    await mkdir(work, { recursive: true });

    const slices = await Promise.all(
        ARCHITECTURES.map(async (architecture) => {
            const output = join(work, `${EXECUTABLE}-${architecture}`);
            await run('xcrun', [
                'swiftc',
                '-O',
                '-swift-version',
                '5',
                '-application-extension',
                '-module-name',
                EXECUTABLE,
                '-target',
                `${architecture}-apple-macos${MINIMUM_MACOS}`,
                join(source, 'ShareViewController.swift'),
                // An app extension has no `main`; Foundation's extension entry point runs the principal class.
                '-Xlinker',
                '-e',
                '-Xlinker',
                '_NSExtensionMain',
                '-o',
                output,
            ]);
            return output;
        }),
    );
    await run('lipo', ['-create', ...slices, '-output', join(macOS, EXECUTABLE)]);
    await rm(work, { force: true, recursive: true });

    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
        version: string;
    };
    const template = await readFile(join(source, 'Info.plist'), 'utf8');
    await writeFile(
        join(bundle, 'Contents', 'Info.plist'),
        shareExtensionInfoPlist(template, packageJson.version),
    );
    await run('codesign', [
        '--force',
        '--sign',
        '-',
        '--entitlements',
        join(source, 'ShareExtension.entitlements'),
        bundle,
    ]);
    console.log(`share extension: ${SHARE_EXTENSION_OUTPUT}`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] === scriptPath) await buildShareExtension(resolve(dirname(scriptPath), '..'));
