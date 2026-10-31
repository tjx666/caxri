/**
 * Prepares the MIT-licensed [alerter](https://github.com/vjeantet/alerter) notification helper that packaged builds
 * ship as `Contents/Resources/bin/alerter` (`build.extraResources` in the root `package.json`). Unsigned and ad-hoc
 * builds deliver clickable banners through it, so bundling it means a user never needs Homebrew for notifications.
 *
 * The pinned release archive is downloaded once into `~/.cache/caxri/alerter`, refused unless it matches
 * {@link ALERTER_ARCHIVE_SHA256}, and unpacked to `out/alerter/alerter`. The upstream binary keeps its own Developer ID
 * signature: `build.mac.signIgnore` stops electron-builder's ad-hoc pass from replacing it. Other platforms skip the
 * step, as the helper is a macOS packaging input only.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const ALERTER_VERSION = '26.5';
export const ALERTER_ARCHIVE_URL = `https://github.com/vjeantet/alerter/releases/download/v${ALERTER_VERSION}/alerter-${ALERTER_VERSION}.zip`;
export const ALERTER_ARCHIVE_SHA256 =
    '11f63cddc9bb3f8554ed9b762632a120cfa7bee05e3c09d65734823e09d24f10';
const ALERTER_OUTPUT = 'out/alerter/alerter';

interface PrepareAlerterOptions {
    cacheDirectory: string;
    /**
     * Fetches the release archive; injected by tests so they never reach the network.
     */
    download: (url: string) => Promise<Uint8Array>;
    expectedSha256?: string;
    outputPath: string;
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

async function readIfExists(path: string): Promise<Uint8Array | undefined> {
    try {
        return await readFile(path);
    } catch {
        return undefined;
    }
}

/**
 * Returns the verified archive, reusing the cached copy when its checksum still matches and downloading otherwise. A
 * download that fails the checksum is never cached or unpacked.
 */
async function verifiedArchive(options: PrepareAlerterOptions): Promise<string> {
    const expected = options.expectedSha256 ?? ALERTER_ARCHIVE_SHA256;
    const archivePath = join(options.cacheDirectory, `alerter-${ALERTER_VERSION}.zip`);
    const cached = await readIfExists(archivePath);
    if (cached && sha256(cached) === expected) return archivePath;
    const downloaded = await options.download(ALERTER_ARCHIVE_URL);
    const actual = sha256(downloaded);
    if (actual !== expected) {
        throw new Error(
            `alerter ${ALERTER_VERSION} archive does not match its pinned SHA-256 (expected ${expected}, got ${actual}).`,
        );
    }
    await mkdir(options.cacheDirectory, { recursive: true });
    const partial = `${archivePath}.partial`;
    await writeFile(partial, downloaded);
    await rename(partial, archivePath);
    return archivePath;
}

export async function prepareAlerter(options: PrepareAlerterOptions): Promise<void> {
    const archivePath = await verifiedArchive(options);
    const outputDirectory = dirname(options.outputPath);
    await rm(outputDirectory, { force: true, recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    // `ditto` ships with macOS and, unlike a JavaScript unzip, keeps the binary's extended attributes and signature.
    await run('ditto', ['-x', '-k', archivePath, outputDirectory]);
    await chmod(options.outputPath, 0o755);
}

async function downloadArchive(url: string): Promise<Uint8Array> {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] === scriptPath) {
    if (process.platform === 'darwin') {
        const repoRoot = resolve(dirname(scriptPath), '..');
        await prepareAlerter({
            cacheDirectory: join(homedir(), '.cache', 'caxri', 'alerter'),
            download: downloadArchive,
            outputPath: join(repoRoot, ALERTER_OUTPUT),
        });
        console.log(`alerter: ${ALERTER_OUTPUT}`);
    } else {
        console.log('alerter: skipped (macOS only)');
    }
}
