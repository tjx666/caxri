#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import {
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { execFileAsync } from './exec';

/* eslint-disable unicorn/no-exports-in-scripts -- exported boundaries are exercised by the runner-cache regression tests. */

const actionShaPattern = /^[0-9a-f]{40}$/u;
const actionRepoPattern = /^[\w.-]+\/[\w.-]+$/u;
const actionArchiveCacheEnvironment = 'ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE';
const yamlExtensions = new Set(['.yaml', '.yml']);

export interface PinnedAction {
    repository: string;
    sha: string;
}

export interface ActionCacheResult extends PinnedAction {
    archive: string;
    status: 'created' | 'repaired' | 'reused';
}

interface ConfigureActionCacheOptions {
    cacheDirectory?: string;
    repositoryRoot: string;
    repositoryUrl?: (repo: string) => string;
    runnerDirectory: string;
}

interface VerifyActionCacheOptions {
    cacheDirectory?: string;
    repositoryRoot: string;
    runnerDirectory: string;
}

interface CliOptions {
    cacheDirectory?: string;
    runnerDirectory: string;
    verifyOnly: boolean;
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
}

async function yamlFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return yamlFiles(path);
            if (!entry.isFile()) return [];
            const extension = entry.name.slice(entry.name.lastIndexOf('.'));
            return yamlExtensions.has(extension) ? [path] : [];
        }),
    );
    return nested.flat().toSorted((left, right) => left.localeCompare(right));
}

function parseExternalAction(reference: string, source: string): PinnedAction | undefined {
    if (reference.startsWith('./') || reference.startsWith('docker://')) return;
    const atIndex = reference.lastIndexOf('@');
    if (atIndex <= 0)
        throw new Error(`Invalid external action reference '${reference}' in ${source}`);

    const repoAndPath = reference.slice(0, atIndex);
    const sha = reference.slice(atIndex + 1);
    const pathSegments = repoAndPath.split('/');
    const repo = pathSegments.slice(0, 2).join('/');
    if (!actionRepoPattern.test(repo) || pathSegments.length < 2) {
        throw new Error(`Invalid external action repository '${reference}' in ${source}`);
    }
    if (!actionShaPattern.test(sha)) {
        throw new Error(
            `External action '${reference}' in ${source} must use a full 40-character commit SHA`,
        );
    }
    return { repository: repo, sha };
}

function collectActionReferences(value: unknown, source: string, actions: PinnedAction[]): void {
    if (Array.isArray(value)) {
        for (const item of value) collectActionReferences(item, source, actions);
        return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
        if (key === 'uses' && typeof child === 'string') {
            const action = parseExternalAction(child, source);
            if (action) actions.push(action);
        } else {
            collectActionReferences(child, source, actions);
        }
    }
}

/**
 * Discovers every external action used by repository workflows and local composite actions. Mutable tags are rejected
 * because the runner archive cache is addressed by the server-resolved commit SHA, not by the workflow ref.
 */
export async function discoverPinnedActions(repoRoot: string): Promise<PinnedAction[]> {
    const githubDirectory = join(resolve(repoRoot), '.github');
    const files = await yamlFiles(githubDirectory);
    const actionGroups = await Promise.all(
        files.map(async (file) => {
            const source = await readFile(file, 'utf8');
            const actions: PinnedAction[] = [];
            collectActionReferences(parse(source), file, actions);
            return actions;
        }),
    );
    const actions = actionGroups.flat();
    const deduplicated = new Map(
        actions.map((action) => [`${action.repository.toLowerCase()}@${action.sha}`, action]),
    );

    return Array.from(deduplicated.values()).toSorted((left, right) =>
        `${left.repository}@${left.sha}`.localeCompare(`${right.repository}@${right.sha}`),
    );
}

export function actionArchivePath(cacheDirectory: string, action: PinnedAction): string {
    return join(
        resolve(cacheDirectory),
        action.repository.replaceAll('/', '_'),
        `${action.sha}.tar.gz`,
    );
}

async function validateActionArchive(archive: string): Promise<void> {
    const { stdout } = await execFileAsync('tar', ['-tzf', archive], {
        maxBuffer: 16 * 1024 * 1024,
    });
    const entries = stdout.split('\n').filter(Boolean);
    if (entries.length === 0) throw new Error(`Action archive is empty: ${archive}`);

    const roots = new Set<string>();
    let hasNestedEntry = false;
    for (const entry of entries) {
        const segments = entry.split('/').filter(Boolean);
        if (
            entry.startsWith('/') ||
            segments.includes('..') ||
            !segments[0] ||
            (segments.length === 1 && !entry.endsWith('/'))
        ) {
            throw new Error(`Action archive contains an unsafe path '${entry}': ${archive}`);
        }
        if (segments.length > 1) hasNestedEntry = true;
        roots.add(segments[0]);
    }
    if (!hasNestedEntry || roots.size !== 1) {
        throw new Error(`Action archive must contain exactly one root directory: ${archive}`);
    }
}

async function isValidActionArchive(archive: string): Promise<boolean> {
    const stats = await lstatIfExists(archive);
    if (!stats) return false;
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Action archive cache entry must be a regular file: ${archive}`);
    }
    try {
        await validateActionArchive(archive);
        return true;
    } catch {
        return false;
    }
}

async function buildActionArchive(
    cacheDirectory: string,
    action: PinnedAction,
    repoUrl: (repo: string) => string,
): Promise<ActionCacheResult> {
    const archive = actionArchivePath(cacheDirectory, action);
    const existing = await lstatIfExists(archive);
    if (await isValidActionArchive(archive)) return { ...action, archive, status: 'reused' };

    const workingDirectory = await mkdtemp(join(tmpdir(), 'caxri-action-cache-'));
    const temporaryArchive = join(dirname(archive), `.${action.sha}.${randomUUID()}.tmp`);
    await mkdir(dirname(archive), { recursive: true });
    try {
        await execFileAsync('git', ['init', '--quiet'], { cwd: workingDirectory });
        await execFileAsync(
            'git',
            [
                '-c',
                'protocol.version=2',
                'fetch',
                '--depth=1',
                '--no-tags',
                repoUrl(action.repository),
                action.sha,
            ],
            { cwd: workingDirectory },
        );
        const { stdout: fetchedHead } = await execFileAsync('git', ['rev-parse', 'FETCH_HEAD'], {
            cwd: workingDirectory,
        });
        if (fetchedHead.trim() !== action.sha) {
            throw new Error(
                `Fetched ${action.repository} at ${fetchedHead.trim()}, expected ${action.sha}`,
            );
        }

        const archiveRoot = `${basename(action.repository)}-${action.sha}`;
        await execFileAsync(
            'git',
            [
                'archive',
                '--format=tar.gz',
                `--prefix=${archiveRoot}/`,
                `--output=${temporaryArchive}`,
                'FETCH_HEAD',
            ],
            { cwd: workingDirectory },
        );
        await validateActionArchive(temporaryArchive);
        await rename(temporaryArchive, archive);
        return { ...action, archive, status: existing ? 'repaired' : 'created' };
    } finally {
        await Promise.all([
            rm(workingDirectory, { force: true, recursive: true }),
            rm(temporaryArchive, { force: true }),
        ]);
    }
}

function environmentFileContents(contents: string, key: string, value: string): string {
    if (key.includes('=') || key.includes('\n') || value.includes('\n')) {
        throw new Error('Runner environment keys and values must be single-line assignments');
    }
    const prefix = `${key}=`;
    const lines = contents.split(/\r?\n/gu).filter((line) => line && !line.startsWith(prefix));
    return `${[...lines, `${prefix}${value}`].join('\n')}\n`;
}

async function configureRunnerEnvironment(runnerDirectory: string, cacheDirectory: string) {
    const environmentFile = join(runnerDirectory, '.env');
    const temporaryFile = join(runnerDirectory, `.env.${randomUUID()}.tmp`);
    const existing = await lstatIfExists(environmentFile);
    const mode = existing ? (await stat(environmentFile)).mode & 0o777 : 0o600;
    const contents = existing ? await readFile(environmentFile, 'utf8') : '';
    try {
        await writeFile(
            temporaryFile,
            environmentFileContents(contents, actionArchiveCacheEnvironment, cacheDirectory),
            { mode },
        );
        await rename(temporaryFile, environmentFile);
    } finally {
        await rm(temporaryFile, { force: true });
    }
}

async function assertRunnerDirectory(runnerDirectory: string): Promise<void> {
    const runnerConfig = await lstatIfExists(join(runnerDirectory, '.runner'));
    const runnerWork = await lstatIfExists(join(runnerDirectory, '_work'));
    if (!runnerConfig?.isFile() || !runnerWork?.isDirectory()) {
        throw new Error(`Not a configured GitHub Actions runner directory: ${runnerDirectory}`);
    }
}

export async function configureActionCache(
    options: ConfigureActionCacheOptions,
): Promise<{ cacheDirectory: string; results: ActionCacheResult[] }> {
    const runnerDirectory = resolve(options.runnerDirectory);
    const cacheDirectory = resolve(
        options.cacheDirectory ?? join(runnerDirectory, '_action-archive-cache'),
    );
    await assertRunnerDirectory(runnerDirectory);
    const actions = await discoverPinnedActions(options.repositoryRoot);
    const repoUrl = options.repositoryUrl ?? ((repo: string) => `https://github.com/${repo}.git`);
    const results = await Promise.all(
        actions.map((action) => buildActionArchive(cacheDirectory, action, repoUrl)),
    );
    await configureRunnerEnvironment(runnerDirectory, cacheDirectory);
    return { cacheDirectory, results };
}

export async function verifyActionCache(
    options: VerifyActionCacheOptions,
): Promise<{ actions: PinnedAction[]; cacheDirectory: string }> {
    const runnerDirectory = resolve(options.runnerDirectory);
    const cacheDirectory = resolve(
        options.cacheDirectory ?? join(runnerDirectory, '_action-archive-cache'),
    );
    await assertRunnerDirectory(runnerDirectory);
    const environment = await readFile(join(runnerDirectory, '.env'), 'utf8');
    if (
        !environment.split(/\r?\n/gu).includes(`${actionArchiveCacheEnvironment}=${cacheDirectory}`)
    ) {
        throw new Error(`${actionArchiveCacheEnvironment} does not point to ${cacheDirectory}`);
    }

    const actions = await discoverPinnedActions(options.repositoryRoot);
    const archives = actions.map((action) => actionArchivePath(cacheDirectory, action));
    const archiveValidity = await Promise.all(archives.map(isValidActionArchive));
    const invalidArchives = archives.filter((_, index) => !archiveValidity[index]);
    if (invalidArchives.length > 0) {
        throw new Error(`Missing or invalid action archives:\n${invalidArchives.join('\n')}`);
    }
    return { actions, cacheDirectory };
}

/* eslint-enable unicorn/no-exports-in-scripts */

function cliOptions(arguments_: string[]): CliOptions {
    let cacheDirectory: string | undefined;
    let runnerDirectory: string | undefined;
    let isVerifyOnly = false;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === '--verify-only') {
            isVerifyOnly = true;
            continue;
        }
        const valueOption = new Map([
            ['--runner-dir', 'runner'],
            ['--cache-dir', 'cache'],
        ]).get(argument);
        if (!valueOption) {
            throw new Error(
                'Usage: configure-actions-runner-cache.ts --runner-dir <path> [--cache-dir <path>] [--verify-only]',
            );
        }
        const value = arguments_[index + 1];
        if (!value) throw new Error(`${argument} requires a path`);
        if (valueOption === 'runner') {
            runnerDirectory = value;
        } else {
            cacheDirectory = value;
        }
        index += 1;
    }
    if (!runnerDirectory) {
        throw new Error('--runner-dir is required');
    }
    return { cacheDirectory, runnerDirectory, verifyOnly: isVerifyOnly };
}

async function main(): Promise<void> {
    const options = cliOptions(process.argv.slice(2));
    const repoRoot = fileURLToPath(new URL('../', import.meta.url));
    if (options.verifyOnly) {
        const verified = await verifyActionCache({ ...options, repositoryRoot: repoRoot });
        console.log(
            `Verified ${verified.actions.length} pinned action archives in ${verified.cacheDirectory}`,
        );
        return;
    }

    const configured = await configureActionCache({ ...options, repositoryRoot: repoRoot });
    for (const result of configured.results) {
        console.log(`${result.status}: ${result.repository}@${result.sha}`);
    }
    console.log(`Configured ${actionArchiveCacheEnvironment}=${configured.cacheDirectory}`);
    console.log('Restart the runner service before dispatching another job.');
}

if (import.meta.main) await main();
