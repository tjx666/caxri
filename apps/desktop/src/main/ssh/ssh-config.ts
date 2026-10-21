import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { SshHostEntry } from '@caxri/protocol';
import { sshDestinationSchema, sshHostEntrySchema } from '@caxri/protocol';
import { atomicWriteFile } from '@caxri/system';

import { parseSshDestination } from './destination';

/**
 * A `~/.ssh/config` larger than this is not a hand-written host list; reading stops instead of loading it whole.
 */
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
/**
 * Bounds `Include` fan-out (globs can match many files) and recursion; OpenSSH itself stops at depth 16.
 */
const MAX_CONFIG_FILES = 64;
const MAX_INCLUDE_DEPTH = 16;
const MAX_HOST_ENTRIES = 512;
export const MAX_RECENT_DESTINATIONS = 20;
const MAX_RECENT_FILE_BYTES = 64 * 1024;

export interface SshConfigListOptions {
    /**
     * The config file to start from; defaults to `~/.ssh/config`.
     */
    configPath?: string;
    /**
     * Base directory for relative `Include` paths; defaults to `~/.ssh`, matching OpenSSH for user configs.
     */
    sshDirectory?: string;
    homeDirectory?: string;
}

interface ParseState {
    entries: Map<string, SshHostEntry>;
    filesRead: number;
    homeDirectory: string;
    sshDirectory: string;
    visited: Set<string>;
}

async function readBounded(path: string): Promise<string | undefined> {
    let handle: FileHandle;
    try {
        handle = await open(path, 'r');
    } catch {
        return undefined;
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) return undefined;
        const length = Math.min(metadata.size, MAX_CONFIG_FILE_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await handle.close();
    }
}

/**
 * A capture group that did not participate in the match is `undefined` at runtime, although `RegExpMatchArray` types
 * every index as `string`.
 */
function optionalGroup(match: RegExpMatchArray, index: number): string | undefined {
    return match[index];
}

/**
 * Splits a config line into keyword and arguments with OpenSSH's rules: the keyword ends at whitespace or `=`, and
 * arguments may be double-quoted to contain spaces.
 */
export function tokenizeConfigLine(
    line: string,
): { arguments: string[]; keyword: string } | undefined {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return undefined;
    const keywordEnd = trimmed.search(/[\s=]/u);
    const keyword = (keywordEnd === -1 ? trimmed : trimmed.slice(0, keywordEnd)).toLowerCase();
    let rest = keywordEnd === -1 ? '' : trimmed.slice(keywordEnd).trimStart();
    if (rest.startsWith('=')) rest = rest.slice(1).trimStart();
    const values: string[] = [];
    for (const part of rest.matchAll(/"([^"]*)"|(\S+)/gu)) {
        const quoted = optionalGroup(part, 1);
        const isQuoted = quoted !== undefined;
        const value = quoted ?? optionalGroup(part, 2) ?? '';
        if (!isQuoted && value.startsWith('#')) break;
        values.push(value);
    }
    return { arguments: values, keyword };
}

function isConcreteAlias(pattern: string): boolean {
    return !/[!*?]/u.test(pattern) && sshDestinationSchema.safeParse(pattern).success;
}

function globToRegExp(segment: string): RegExp {
    const escaped = segment.replaceAll(/[$()+.[\\\]^{|}]/gu, String.raw`\$&`);
    return new RegExp(`^${escaped.replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`, 'u');
}

async function matchSegment(directory: string, matcher: RegExp): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(directory);
    } catch {
        return [];
    }
    return names
        .filter((name) => !name.startsWith('.') && matcher.test(name))
        .toSorted((left, right) => left.localeCompare(right))
        .map((name) => join(directory, name));
}

/**
 * Expands one `Include` argument. Only `*` and `?` are supported, which covers the `config.d/*` convention; matches are
 * returned sorted, as OpenSSH's `glob(3)` returns them.
 */
async function expandInclude(pattern: string, state: ParseState): Promise<string[]> {
    let path = pattern;
    if (path.startsWith('~/')) path = join(state.homeDirectory, path.slice(2));
    else if (!isAbsolute(path)) path = join(state.sshDirectory, path);
    const segments = path.split('/').filter((segment) => segment !== '');
    let candidates = ['/'];
    for (const segment of segments) {
        if (/[*?]/u.test(segment)) {
            const matcher = globToRegExp(segment);
            // eslint-disable-next-line no-await-in-loop -- glob segments expand in order and stay bounded.
            const expanded = await Promise.all(
                candidates.map((candidate) => matchSegment(candidate, matcher)),
            );
            candidates = expanded.flat().slice(0, MAX_CONFIG_FILES);
        } else {
            candidates = candidates.map((candidate) => join(candidate, segment));
        }
    }
    return candidates;
}

function parsePortValue(value: string): number | undefined {
    if (!/^\d{1,5}$/u.test(value)) return undefined;
    const port = Number(value);
    return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * Applies one option line to every alias of the current `Host` block. OpenSSH keeps the first value it obtains for each
 * option, so a later block never overrides an earlier one.
 */
function applyOption(entry: SshHostEntry, keyword: string, value: string): void {
    if (value.length > 255) return;
    if (keyword === 'hostname') entry.hostName ??= value;
    else if (keyword === 'user') entry.user ??= value;
    else if (keyword === 'port' && entry.port === undefined) {
        const port = parsePortValue(value);
        if (port !== undefined) entry.port = port;
    }
}

function addHosts(state: ParseState, aliases: readonly string[]): void {
    for (const alias of aliases) {
        if (state.entries.size >= MAX_HOST_ENTRIES) return;
        if (!state.entries.has(alias)) state.entries.set(alias, { alias });
    }
}

/**
 * Applies one config line and returns the aliases of the `Host` block that follows it. `Match` blocks reset it: their
 * conditions cannot be evaluated here, so their settings are not attributed to any alias.
 */
async function applyLine(
    tokens: { arguments: string[]; keyword: string },
    current: string[],
    depth: number,
    state: ParseState,
): Promise<string[]> {
    const { keyword, arguments: values } = tokens;
    if (keyword === 'host') {
        const aliases = values.filter((value) => isConcreteAlias(value));
        addHosts(state, aliases);
        return aliases;
    }
    if (keyword === 'match') return [];
    if (keyword === 'include') {
        const included = await Promise.all(values.map((value) => expandInclude(value, state)));
        for (const includedPath of included.flat())
            // eslint-disable-next-line no-await-in-loop -- includes are read in file order, like OpenSSH.
            await parseConfigFile(includedPath, depth + 1, state);
        return current;
    }
    const value = values.at(0);
    if (value === undefined) return current;
    for (const alias of current) {
        const entry = state.entries.get(alias);
        if (entry) applyOption(entry, keyword, value);
    }
    return current;
}

async function parseConfigFile(path: string, depth: number, state: ParseState): Promise<void> {
    if (depth > MAX_INCLUDE_DEPTH || state.filesRead >= MAX_CONFIG_FILES || state.visited.has(path))
        return;
    state.visited.add(path);
    state.filesRead += 1;
    const source = await readBounded(path);
    if (source === undefined) return;
    let current: string[] = [];
    const lines = source.split(/\r?\n/u);
    for (const line of lines) {
        const tokens = tokenizeConfigLine(line);
        // eslint-disable-next-line no-await-in-loop -- lines apply in order; an Include splices its files in place.
        if (tokens) current = await applyLine(tokens, current, depth, state);
    }
}

/**
 * Lists the concrete `Host` aliases a user can pick from, following `Include` and skipping wildcard and negated
 * patterns. Unreadable or missing files yield an empty list rather than an error, because the picker is a convenience
 * and any destination can still be typed.
 */
export async function listSshConfigHosts(
    options: SshConfigListOptions = {},
): Promise<SshHostEntry[]> {
    const homeDirectory = options.homeDirectory ?? homedir();
    const sshDirectory = options.sshDirectory ?? join(homeDirectory, '.ssh');
    const state: ParseState = {
        entries: new Map(),
        filesRead: 0,
        homeDirectory,
        sshDirectory,
        visited: new Set(),
    };
    await parseConfigFile(options.configPath ?? join(sshDirectory, 'config'), 0, state);
    const hosts: SshHostEntry[] = [];
    for (const entry of state.entries.values()) {
        const parsed = sshHostEntrySchema.safeParse(entry);
        if (!parsed.success) continue;
        try {
            parseSshDestination(parsed.data.alias);
        } catch {
            continue;
        }
        hosts.push(parsed.data);
    }
    return hosts;
}

/**
 * Most-recent-first list of destinations the user connected to, persisted as one small JSON file. Writes go through a
 * temp file and rename so a crash never leaves a truncated list.
 */
export class RecentSshDestinations {
    readonly path: string;

    constructor(directory: string, fileName = 'recent-ssh-destinations.json') {
        this.path = join(directory, fileName);
    }

    async list(): Promise<string[]> {
        const source = await readBounded(this.path);
        if (source === undefined || source.length > MAX_RECENT_FILE_BYTES) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch {
            return [];
        }
        const values =
            typeof parsed === 'object' && parsed !== null && 'destinations' in parsed
                ? Reflect.get(parsed, 'destinations')
                : undefined;
        if (!Array.isArray(values)) return [];
        const destinations = new Set<string>();
        for (const value of values as unknown[]) {
            if (destinations.size >= MAX_RECENT_DESTINATIONS) break;
            const destination = sshDestinationSchema.safeParse(value);
            if (destination.success) destinations.add(destination.data);
        }
        return [...destinations];
    }

    async record(destination: string): Promise<string[]> {
        const value = sshDestinationSchema.parse(destination);
        const next = [value, ...(await this.list()).filter((item) => item !== value)].slice(
            0,
            MAX_RECENT_DESTINATIONS,
        );
        await atomicWriteFile(this.path, `${JSON.stringify({ destinations: next })}\n`, {
            durability: 'durable',
        });
        return next;
    }
}
