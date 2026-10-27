import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createZstdDecompress } from 'node:zlib';

import type { DevelopmentUsageSummary, JsonRecord } from './development-usage';
import {
    CodexLedger,
    DevelopmentUsage,
    isProjectCwd,
    record,
    renderDevelopmentUsage,
    timestamp,
    updateDevelopmentUsageReadme,
} from './development-usage';
import { formatSource } from './format-source';

/**
 * Personal archive locations are relative to the runtime home, never a maintainer's absolute path.
 */
export const CLAUDE_BACKUPS = [
    '~/Documents/Claude Backups/claude-reinstall-20261005-120742/.claude-original/projects',
    '~/play/backups/claude-account-cleanup-20261003-135150/files/.claude/projects',
    '~/play/backups/claude-residue-cleanup-20261003-213322/files/.claude/projects',
];

export interface CollectDevelopmentUsageOptions {
    home: string;
    asOf: string;
    codexHome?: string;
    claudeBackups?: string[];
    excludedThreadId?: string;
}

export function expandHome(path: string, home: string): string {
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : resolve(path);
}

async function entries(path: string): Promise<string[]> {
    try {
        return await readdir(path);
    } catch (error) {
        if (record(error).code === 'ENOENT') return [];
        throw new Error('A configured session directory could not be read.', { cause: error });
    }
}

async function files(path: string, canInclude: (name: string) => boolean): Promise<string[]> {
    let children: Dirent[];
    try {
        children = await readdir(path, { withFileTypes: true });
    } catch (error) {
        if (record(error).code === 'ENOENT') return [];
        throw new Error('A configured session directory could not be read.', { cause: error });
    }
    const groups = await Promise.all(
        children.map(async (child): Promise<string[]> => {
            const target = join(path, child.name);
            if (child.isDirectory()) return files(target, canInclude);
            return child.isFile() && canInclude(child.name) ? [target] : [];
        }),
    );
    return groups.flat().toSorted((left, right) => left.localeCompare(right));
}

/**
 * JSONL uses LF bytes: Unicode line separators inside JSON strings must remain intact. Keep partial UTF-8 bytes until a
 * complete line arrives, including a final line without LF.
 *
 * @yields {string} One LF-delimited JSONL record with an optional trailing CR removed.
 */
export async function* jsonlLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
    const pending: Buffer[] = [];
    for await (const chunk of chunks) {
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let start = 0;
        let end = buffer.indexOf(10);
        while (end !== -1) {
            pending.push(buffer.subarray(start, end));
            yield Buffer.concat(pending).toString('utf8').replace(/\r$/, '');
            pending.length = 0;
            start = end + 1;
            end = buffer.indexOf(10, start);
        }
        if (start < buffer.length) pending.push(buffer.subarray(start));
    }
    if (pending.length > 0) yield Buffer.concat(pending).toString('utf8').replace(/\r$/, '');
}

/**
 * Stream compressed rollouts as well as plain JSONL; closing a metadata probe also closes its input.
 *
 * @yields {string} One transcript line, retained only in memory while extracting usage.
 */
async function* lines(path: string): AsyncGenerator<string> {
    const source = createReadStream(path);
    const input = path.endsWith('.zst') ? source.pipe(createZstdDecompress()) : source;
    if (input !== source) source.on('error', (error) => input.destroy(error));
    try {
        yield* jsonlLines(input);
    } finally {
        input.destroy();
        source.destroy();
    }
}

function parse(line: string, usage?: DevelopmentUsage): JsonRecord {
    try {
        return record(JSON.parse(line));
    } catch {
        usage?.mark('malformedLines');
        return {};
    }
}

async function concurrent<T>(items: T[], consume: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(4, items.length) }, async () => {
            while (next < items.length) {
                // eslint-disable-next-line no-await-in-loop -- Await each file to bound simultaneous transcript streams.
                await consume(items[next++]);
            }
        }),
    );
}

export function excludedDescendants(
    metadata: Map<string, { parent?: string }>,
    current?: string,
): Set<string> {
    const excluded = new Set<string>(current ? [current] : []);
    let previous = -1;
    while (previous !== excluded.size) {
        previous = excluded.size;
        for (const [id, meta] of metadata)
            if (meta.parent && excluded.has(meta.parent)) excluded.add(id);
    }
    return excluded;
}

async function codex(
    options: CollectDevelopmentUsageOptions,
    usage: DevelopmentUsage,
): Promise<void> {
    const root = options.codexHome ?? join(options.home, '.codex');
    const paths = [
        ...(await files(join(root, 'sessions'), (name) => /\.jsonl(?:\.zst)?$/.test(name))),
        ...(await files(join(root, 'archived_sessions'), (name) =>
            /\.jsonl(?:\.zst)?$/.test(name),
        )),
    ];
    const metadata = new Map<string, { parent?: string }>();
    const selected: Array<{ path: string; id: string; isInProject: boolean }> = [];
    await concurrent(paths, async (path) => {
        for await (const line of lines(path)) {
            const entry = parse(line);
            if (entry.type !== 'session_meta') break;
            const payload = record(entry.payload);
            const id = typeof payload.id === 'string' ? payload.id : path;
            const parent = record(
                record(record(payload.source).subagent).thread_spawn,
            ).parent_thread_id;
            metadata.set(id, { parent: typeof parent === 'string' ? parent : undefined });
            selected.push({ path, id, isInProject: isProjectCwd(payload.cwd) });
            break;
        }
    });
    const excluded = excludedDescendants(metadata, options.excludedThreadId);
    await concurrent(
        selected.toSorted((left, right) => left.path.localeCompare(right.path)),
        async ({ path, id, isInProject }) => {
            if (excluded.has(id)) {
                usage.mark('codexExcludedFiles');
                return;
            }
            usage.mark('codexFilesScanned');
            // A rollout can enter or leave this project after session creation, so inspect every file.
            const ledger = new CodexLedger(isInProject);
            let lineNumber = 0;
            for await (const line of lines(path)) {
                lineNumber += 1;
                if (!/"(?:turn_context|token_usage_record|token_count)"/.test(line)) continue;
                ledger.consume(parse(line, usage), lineNumber);
            }
            for (const unit of ledger.finish()) usage.add(unit.request, unit.aliases);
        },
    );
}

async function claude(
    options: CollectDevelopmentUsageOptions,
    usage: DevelopmentUsage,
): Promise<void> {
    const candidates = [
        join(options.home, '.claude/projects'),
        ...(options.claudeBackups ?? CLAUDE_BACKUPS).map((path) => expandHome(path, options.home)),
    ];
    const resolved = await Promise.all(
        candidates.map(async (candidate) => {
            try {
                return await realpath(candidate);
            } catch (error) {
                if (record(error).code !== 'ENOENT')
                    throw new Error('A Claude session root could not be resolved.', {
                        cause: error,
                    });
                usage.mark('missingClaudeRoots');
                return;
            }
        }),
    );
    const roots = new Set(resolved.filter((root) => root !== undefined));
    const groups = await Promise.all(
        [...roots].map(async (root) => {
            const projects = await entries(root);
            return projects.map((project) => join(root, project));
        }),
    );
    const logs = await Promise.all(
        groups.flat().map((project) => files(project, (name) => name.endsWith('.jsonl'))),
    );
    const paths = logs.flat().toSorted((left, right) => left.localeCompare(right));
    await concurrent(paths, async (path) => {
        usage.mark('claudeFilesScanned');
        for await (const line of lines(path)) {
            if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
            usage.claude(parse(line, usage));
        }
    });
}

async function grok(
    options: CollectDevelopmentUsageOptions,
    usage: DevelopmentUsage,
): Promise<void> {
    const summaries = await files(
        join(options.home, '.grok/sessions'),
        (name) => name === 'summary.json',
    );
    await concurrent(summaries, async (path) => {
        const summary = parse(await readFile(path, 'utf8'), usage);
        const info = record(summary.info);
        if (!isProjectCwd(info.cwd)) return;
        const created = timestamp(summary.created_at);
        if (created && created > options.asOf) return;
        usage.mark('grokSessions');
        const updates = path.replace(/summary\.json$/, 'updates.jsonl');
        let isMeasured = false;
        try {
            for await (const line of lines(updates)) {
                if (!line.includes('turn_completed')) continue;
                isMeasured =
                    usage.grok(
                        parse(line, usage),
                        typeof summary.current_model_id === 'string'
                            ? summary.current_model_id
                            : 'unknown',
                    ) || isMeasured;
            }
        } catch (error) {
            if (record(error).code !== 'ENOENT') throw error;
        }
        if (!isMeasured) usage.mark('grokSessionsWithoutUsage');
    });
}

export async function collectDevelopmentUsage(
    options: CollectDevelopmentUsageOptions,
): Promise<DevelopmentUsageSummary> {
    const usage = new DevelopmentUsage(options.asOf);
    await codex(options, usage);
    await claude(options, usage);
    await grok(options, usage);
    return usage.summary();
}

async function main(): Promise<void> {
    const arguments_ = process.argv.slice(2);
    let asOf = new Date().toISOString();
    let isWrite = false;
    let isJson = false;
    const backups: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === '--write') isWrite = true;
        else if (argument === '--json') isJson = true;
        else if (argument === '--as-of' && arguments_[index + 1]) {
            const value = timestamp(arguments_[++index]);
            if (!value) throw new Error('Expected a valid ISO timestamp after --as-of.');
            asOf = value;
        } else if (argument === '--claude-backup' && arguments_[index + 1])
            backups.push(arguments_[++index]);
        else if (argument === '--help') {
            console.log(
                'Usage: bun run usage:development [--write] [--json] [--as-of <ISO timestamp>] [--claude-backup <projects directory>]',
            );
            return;
        } else throw new Error('Unknown option. Run with --help for supported options.');
    }
    const home = homedir();
    const summary = await collectDevelopmentUsage({
        home,
        asOf,
        codexHome: process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME, home) : undefined,
        claudeBackups: [...CLAUDE_BACKUPS, ...backups],
        excludedThreadId: process.env.CODEX_THREAD_ID,
    });
    if (isWrite) {
        if (Object.values(summary.providers).every((total) => !(total.tokens > 0)))
            throw new Error('No attributable usage found; README was not changed.');
        const path = fileURLToPath(new URL('../README.md', import.meta.url));
        const readme = await readFile(path, 'utf8');
        const block = await formatSource(renderDevelopmentUsage(summary), path);
        await writeFile(path, updateDevelopmentUsageReadme(readme, summary, block.trimEnd()));
    }
    console.log(isJson ? JSON.stringify(summary, null, 2) : renderDevelopmentUsage(summary));
}

if (import.meta.main) {
    try {
        await main();
    } catch {
        console.error(
            'Development usage update failed. Check source availability, JSONL compression support and CLI options. No source contents or paths are logged.',
        );
        process.exitCode = 1;
    }
}
