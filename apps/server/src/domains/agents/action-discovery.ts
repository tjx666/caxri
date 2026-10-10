import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';

import type { AgentAction } from '@caxri/protocol';
import { agentActionSchema, requiresAgentActionArguments } from '@caxri/protocol';
import { mapWithConcurrency } from '@caxri/system';

import type { AgentActionDiscoveryAdapter, AgentActionDiscoveryRoot } from './contract';

const MAX_ACTION_FILE_BYTES = 64 * 1024;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_ENTRIES = 1_024;
const MAX_DISCOVERED_ACTIONS = 256;

interface DiscoveryResult {
    actions: AgentAction[];
    /**
     * The canonical file each discovered invocation came from, kept Server-side so the wire never carries a path.
     */
    files: Map<string, string>;
    partial: boolean;
}

interface Frontmatter {
    argumentHint?: string;
    description?: string;
    name?: string;
    userInvocable?: boolean;
}

const isInside = (root: string, target: string): boolean => {
    const suffix = relative(root, target);
    return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..');
};

const safeText = (value: unknown, maxLength: number): string | undefined => {
    if (typeof value !== 'string') return;
    const withoutControls = [...value]
        .map((character) => {
            const code = character.codePointAt(0)!;
            return code === 127 || code <= 31 ? ' ' : character;
        })
        .join('');
    const normalized = withoutControls.replaceAll(/\s+/gu, ' ').trim();
    if (!normalized) return;
    let bounded = '';
    for (const character of normalized) {
        if (bounded.length + character.length > maxLength) break;
        bounded += character;
    }
    return bounded;
};

const scalar = (raw: string): string => {
    const value = raw.trim();
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
    ) {
        return value.slice(1, -1);
    }
    return value;
};

/**
 * Skill metadata is untrusted input. The picker needs only four scalar keys, so a small bounded parser avoids YAML
 * aliases, custom tags, and object graphs while still accepting the frontmatter emitted by both supported CLIs.
 */
function parseFrontmatter(source: string): Frontmatter {
    if (!source.startsWith('---')) return {};
    const end = source.indexOf('\n---', 3);
    if (end === -1) return {};
    const values = new Map<string, string>();
    const lines = source.slice(3, end).split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        // An indented line belongs to the key above it (a nested map or a block scalar), never a top-level key.
        if (/^\s/u.test(line)) continue;
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        let value = line.slice(separator + 1).trim();
        /**
         * A block scalar (`description: |` or `>-`) keeps its text on the indented lines below. Reading only the
         * indicator showed `|` as a skill's description in the Chat composer's menu; `safeText` folds the joined
         * lines.
         */
        if (/^[|>][+-]?$/u.test(value)) {
            const block: string[] = [];
            while (index + 1 < lines.length && /^(?:\s|$)/u.test(lines[index + 1]))
                block.push(lines[++index].trim());
            value = block.join('\n');
        } else {
            value = scalar(value);
        }
        values.set(line.slice(0, separator).trim().toLowerCase(), value);
    }
    return {
        name: safeText(values.get('name'), 120),
        description: safeText(values.get('description'), 240),
        argumentHint: safeText(values.get('argument-hint'), 120),
        userInvocable: !values.has('user-invocable')
            ? undefined
            : values.get('user-invocable')?.toLowerCase() !== 'false',
    };
}

async function readMetadata(path: string): Promise<Frontmatter> {
    return parseFrontmatter(await readActionFile(path));
}

/**
 * Reads one discovered action file, bounded like discovery itself.
 */
export async function readActionFile(path: string): Promise<string> {
    const handle = await open(path, 'r');
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_ACTION_FILE_BYTES)
            throw new Error('Agent action metadata is not a bounded regular file');
        const buffer = Buffer.allocUnsafe(stats.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await handle.close();
    }
}

const isValidName = (value: string | undefined): value is string =>
    Boolean(value && /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,119}$/u.test(value));

async function actionFromFile(
    path: string,
    relativePath: string,
    root: AgentActionDiscoveryRoot,
    adapter: AgentActionDiscoveryAdapter,
): Promise<AgentAction | undefined> {
    const metadata = await readMetadata(path);
    if (metadata.userInvocable === false) return;
    const kind = root.kind === 'skills' ? 'skill' : 'command';
    const fallbackName =
        kind === 'skill'
            ? basename(relativePath.slice(0, -'/SKILL.md'.length))
            : relativePath.slice(0, -extname(relativePath).length);
    const name = kind === 'skill' && isValidName(metadata.name) ? metadata.name : fallbackName;
    const invocation =
        kind === 'skill' ? adapter.skillInvocation(name) : adapter.commandInvocation?.(name);
    if (!invocation || !isValidName(invocation.slice(1).replaceAll('/', ':')))
        throw new Error('Agent action metadata produced an invalid invocation');
    const parsed = agentActionSchema.safeParse({
        invocation,
        kind,
        description: metadata.description,
        argumentHint: metadata.argumentHint,
        requiresArguments: requiresAgentActionArguments(metadata.argumentHint),
        source: root.scope,
    });
    if (!parsed.success) throw new Error('Agent action metadata failed the wire schema');
    return parsed.data;
}

async function scanRoot(
    root: AgentActionDiscoveryRoot,
    adapter: AgentActionDiscoveryAdapter,
): Promise<DiscoveryResult> {
    let canonicalRoot: string;
    try {
        canonicalRoot = await realpath(root.directory);
    } catch (error) {
        /**
         * Optional provider roots commonly do not exist; absence is a complete empty result, not an error state.
         */
        const code =
            typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined;
        return { actions: [], files: new Map(), partial: code !== 'ENOENT' };
    }
    let canonicalBoundary: string | undefined;
    if (root.boundaryDirectory) {
        try {
            canonicalBoundary = await realpath(root.boundaryDirectory);
            if (!isInside(canonicalBoundary, canonicalRoot))
                return { actions: [], files: new Map(), partial: true };
        } catch {
            return { actions: [], files: new Map(), partial: true };
        }
    }
    /**
     * Entries are authorized against the Project boundary, not the narrower discovery root, so a skill symlinked from
     * elsewhere inside the same Project (e.g. a nested checkout) still resolves instead of being treated as an escape.
     */
    const containmentRoot = canonicalBoundary ?? canonicalRoot;
    const queue = [{ directory: canonicalRoot, depth: 0, relativeDirectory: '' }];
    const actions: AgentAction[] = [];
    const files = new Map<string, string>();
    const seenDirectories = new Set<string>();
    let visitedEntries = 0;
    let isPartial = false;
    while (queue.length > 0) {
        const current = queue.shift()!;
        if (seenDirectories.has(current.directory)) continue;
        seenDirectories.add(current.directory);
        let entries: Array<Dirent<string>>;
        try {
            // eslint-disable-next-line no-await-in-loop -- bounded breadth-first traversal preserves provider precedence
            entries = await readdir(current.directory, { withFileTypes: true });
        } catch {
            isPartial = true;
            continue;
        }
        const sortedEntries = entries.toSorted((left, right) =>
            left.name.localeCompare(right.name),
        );
        for (const entry of sortedEntries) {
            visitedEntries += 1;
            if (visitedEntries > MAX_DISCOVERY_ENTRIES) return { actions, files, partial: true };
            const path = join(current.directory, entry.name);
            let canonicalPath: string | undefined;
            try {
                // eslint-disable-next-line no-await-in-loop -- every symlink target must be authorized before use
                canonicalPath = await realpath(path);
            } catch {
                isPartial = true;
            }
            if (canonicalPath && !isInside(containmentRoot, canonicalPath)) {
                isPartial = true;
            }
            if (canonicalPath && isInside(containmentRoot, canonicalPath)) {
                const relativePath = current.relativeDirectory
                    ? `${current.relativeDirectory}/${entry.name}`
                    : entry.name;
                const isActionFile =
                    root.kind === 'skills'
                        ? entry.name === 'SKILL.md'
                        : extname(entry.name).toLowerCase() === '.md';
                if (isActionFile) {
                    try {
                        // eslint-disable-next-line no-await-in-loop -- bounded reads keep deterministic precedence
                        const action = await actionFromFile(
                            canonicalPath,
                            relativePath,
                            root,
                            adapter,
                        );
                        if (action) {
                            if (actions.length < MAX_DISCOVERED_ACTIONS) {
                                actions.push(action);
                                files.set(action.invocation, canonicalPath);
                            } else isPartial = true;
                        }
                    } catch {
                        isPartial = true;
                    }
                } else if (
                    current.depth < MAX_DISCOVERY_DEPTH &&
                    (entry.isDirectory() || entry.isSymbolicLink())
                ) {
                    queue.push({
                        directory: canonicalPath,
                        depth: current.depth + 1,
                        relativeDirectory: relativePath,
                    });
                }
            }
        }
    }
    return { actions, files, partial: isPartial };
}

export async function discoverAgentActions(
    adapter: AgentActionDiscoveryAdapter,
    roots: AgentActionDiscoveryRoot[],
): Promise<DiscoveryResult> {
    const merged = new Map<string, AgentAction>();
    const files = new Map<string, string>();
    let isPartial = false;
    const results = await mapWithConcurrency(roots, 4, (root) => scanRoot(root, adapter));
    for (const result of results) {
        isPartial ||= result.partial;
        for (const action of result.actions) merged.set(action.invocation, action);
        for (const [invocation, file] of result.files) files.set(invocation, file);
    }
    const actions = merged.values().toArray();
    return {
        actions,
        files,
        partial: isPartial || actions.length > MAX_DISCOVERED_ACTIONS,
    };
}
