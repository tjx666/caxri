/**
 * Rewrites E2E failure artifacts in place so they can be uploaded without naming the runner account (issue #1461).
 *
 * The structured `.jsonl` logs already redact home paths at the writer, but Playwright's own outputs do not:
 * `error-context.md` and `trace.zip` carry absolute workspace paths in stack frames and fixture paths in error text and
 * DOM snapshots. On the self-hosted runner both the workspace and the job temp root sit under the runner account's
 * home, so every one of those paths names the account. This replaces each home prefix with `$HOME` in text files and in
 * the text entries of nested `.zip` archives; binary entries (screenshots) cannot carry a path and stay untouched.
 *
 * Usage: `bun run scripts/redact-e2e-artifacts.ts <directory>...`; missing directories are skipped so CI can name every
 * pool's output directory unconditionally.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec.ts';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The OS account home comes from the password database, so it still resolves when a job overrides `HOME`.
 */

export function artifactHomePrefixes(): string[] {
    let accountHome: string | undefined;
    try {
        accountHome = userInfo().homedir;
    } catch {
        accountHome = undefined;
    }
    return [...new Set([accountHome, homedir()])]
        .filter((home): home is string => Boolean(home) && home !== '/')
        .toSorted((left, right) => right.length - left.length);
}

/**
 * Returns the redacted text, or `undefined` for content that is not UTF-8 text or holds no home prefix.
 */

export function redactArtifactText(
    content: Uint8Array,
    homes: readonly string[],
): string | undefined {
    if (content.includes(0)) return undefined;
    let text: string;
    try {
        text = utf8.decode(content);
    } catch {
        return undefined;
    }
    const redacted = homes.reduce((value, home) => value.replaceAll(home, '$HOME'), text);
    return redacted === text ? undefined : redacted;
}

async function redactArchive(path: string, homes: readonly string[]): Promise<number> {
    const extracted = await mkdtemp(join(tmpdir(), 'caxri-artifact-redaction-'));
    try {
        await execFileAsync('/usr/bin/unzip', ['-qq', '-o', path, '-d', extracted]);
        const changed = await redactTree(extracted, homes);
        if (changed > 0) {
            await rm(path);
            await execFileAsync('/usr/bin/zip', ['-qq', '-X', '-D', '-r', path, '.'], {
                cwd: extracted,
            });
        }
        return changed;
    } finally {
        await rm(extracted, { recursive: true, force: true });
    }
}

async function redactFile(path: string, homes: readonly string[]): Promise<number> {
    if (path.endsWith('.zip')) return redactArchive(path, homes);
    const redacted = redactArtifactText(await readFile(path), homes);
    if (redacted === undefined) return 0;
    await writeFile(path, redacted, 'utf8');
    return 1;
}

/**
 * Redacts every file beneath `root` and returns how many files (including archive entries) changed.
 */

export async function redactTree(root: string, homes: readonly string[]): Promise<number> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const counts = await Promise.all(
        entries
            .filter((entry) => entry.isFile())
            .map((entry) => redactFile(join(entry.parentPath, entry.name), homes)),
    );
    return counts.reduce((total, count) => total + count, 0);
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const directories = process.argv.slice(2);
    if (directories.length === 0) throw new Error('Usage: redact-e2e-artifacts.ts <directory>...');
    const homes = artifactHomePrefixes();
    const results = await Promise.all(
        directories.map(async (directory) => {
            const absolute = resolve(directory);
            if (!(await isDirectory(absolute))) return;
            return { changed: await redactTree(absolute, homes), directory };
        }),
    );
    for (const result of results) {
        if (result)
            console.log(
                `Redacted home paths in ${result.changed} artifact file(s) under ${result.directory}`,
            );
    }
}

if (import.meta.main) await main();
