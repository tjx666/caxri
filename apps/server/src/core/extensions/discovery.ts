import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ExtensionError, ExtensionManifest } from '@caxri/protocol';
import { extensionIdSchema, extensionManifestSchema } from '@caxri/protocol';
import { satisfies } from 'semver';

import { readBoundedRegularFileText } from '../../domains/bounded-file-reader';

export interface DiscoveredExtension {
    extensionId: string;
    source: 'bundled' | 'installed';
    rootPath: string;
    entryPath: string;
    manifest: ExtensionManifest;
}

const MAX_EXTENSION_MANIFEST_BYTES = 256 * 1_024;

/**
 * An installed extension root is user-writable, so its manifest goes through the shared bounded reader: a FIFO planted
 * as `package.json` is rejected as one invalid extension instead of blocking discovery of every sibling until a writer
 * appears.
 */
function readManifestSource(path: string): Promise<string> {
    return readBoundedRegularFileText(path, MAX_EXTENSION_MANIFEST_BYTES, {
        capacityMessage: 'Extension package.json exceeds the 256 KiB limit',
        notRegularFileMessage: 'Extension package.json is not a regular file',
    });
}

export interface RejectedExtension {
    extensionId: string;
    version: string;
    error: ExtensionError;
}

function extensionError(code: ExtensionError['code'], message: string): ExtensionError {
    return { code, message: message.slice(0, 2_048) };
}

function isEngineCompatible(range: string, version: string): boolean {
    try {
        return satisfies(version, range);
    } catch {
        return false;
    }
}

function rejectedExtensionId(entryName: string, rootIndex: number): string {
    const slug =
        entryName
            .toLowerCase()
            .replaceAll(/[^a-z0-9-]+/g, '-')
            .replaceAll(/^-+|-+$/g, '')
            .slice(0, 120)
            .replaceAll(/-+$/g, '') || 'extension';
    const digest = createHash('sha256')
        .update(`${rootIndex}:${entryName}`)
        .digest('hex')
        .slice(0, 12);
    return `invalid.${slug}-${digest}`;
}

function rejectedVersion(value: unknown): string {
    return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : 'unknown';
}

function isInside(rootPath: string, candidate: string): boolean {
    const nested = relative(rootPath, candidate);
    return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested));
}

interface DiscoveryOptions {
    roots: readonly string[];
    appVersion: string;
    includeTestOnly: boolean;
}

type EntryDiscoveryResult =
    | { kind: 'extension'; value: DiscoveredExtension }
    | { kind: 'rejected'; value: RejectedExtension; reservedExtensionId?: string }
    | undefined;

function rejectedIdentifiedExtension(options: {
    code: ExtensionError['code'];
    entryName: string;
    rootIndex: number;
    manifest: ExtensionManifest;
    message: string;
    reserveBundledIdentity?: boolean;
}): Exclude<EntryDiscoveryResult, { kind: 'extension' } | undefined> {
    const {
        code,
        entryName,
        rootIndex,
        manifest,
        message,
        reserveBundledIdentity = true,
    } = options;
    return {
        kind: 'rejected',
        value: {
            extensionId: rejectedExtensionId(entryName, rootIndex),
            version: manifest.version,
            error: extensionError(code, message),
        },
        ...(rootIndex === 0 && reserveBundledIdentity && { reservedExtensionId: manifest.name }),
    };
}

function recordDiscoveryResult(
    result: EntryDiscoveryResult,
    discoveredIds: Set<string>,
    extensions: DiscoveredExtension[],
    rejected: RejectedExtension[],
): void {
    /**
     * A visible entry in an earlier root owns its extension id even when its manifest or engine is rejected. Otherwise
     * an installed extension could impersonate a broken bundled extension and replace its catalog.
     */
    if (result) {
        discoveredIds.add(result.value.extensionId);
        if (result.kind === 'rejected' && result.reservedExtensionId)
            discoveredIds.add(result.reservedExtensionId);
    }
    if (result?.kind === 'extension') extensions.push(result.value);
    else if (result?.kind === 'rejected') rejected.push(result.value);
}

interface DiscoveryAccumulator {
    discoveredIds: Set<string>;
    extensions: DiscoveredExtension[];
    rejected: RejectedExtension[];
}

async function discoverDirectoryEntries(
    entries: readonly Dirent[],
    entryIndex: number,
    rootIndex: number,
    sourceRoot: string,
    options: DiscoveryOptions,
    accumulator: DiscoveryAccumulator,
): Promise<void> {
    if (entryIndex >= entries.length) return;
    const entry = entries[entryIndex];
    const result = await discoverEntry({
        entry,
        rootIndex,
        sourceRoot,
        appVersion: options.appVersion,
        includeTestOnly: options.includeTestOnly,
        discoveredIds: accumulator.discoveredIds,
    });
    recordDiscoveryResult(
        result,
        accumulator.discoveredIds,
        accumulator.extensions,
        accumulator.rejected,
    );
    // eslint-disable-next-line unicorn/no-useless-recursion -- sequential precedence is the security boundary
    return discoverDirectoryEntries(
        entries,
        entryIndex + 1,
        rootIndex,
        sourceRoot,
        options,
        accumulator,
    );
}

async function discoverSourceRoot(
    sourceRoot: string,
    rootIndex: number,
    options: DiscoveryOptions,
    accumulator: DiscoveryAccumulator,
): Promise<void> {
    let entries: Dirent[];
    try {
        entries = await readdir(sourceRoot, { withFileTypes: true });
    } catch {
        return;
    }
    return discoverDirectoryEntries(
        entries
            .filter((candidate) => candidate.isDirectory())
            .toSorted((left, right) => left.name.localeCompare(right.name)),
        0,
        rootIndex,
        sourceRoot,
        options,
        accumulator,
    );
}

async function discoverSourceRoots(
    rootIndex: number,
    options: DiscoveryOptions,
    accumulator: DiscoveryAccumulator,
): Promise<void> {
    if (rootIndex >= options.roots.length) return;
    const sourceRoot = options.roots[rootIndex];
    await discoverSourceRoot(sourceRoot, rootIndex, options, accumulator);
    // eslint-disable-next-line unicorn/no-useless-recursion -- roots must stay ordered for bundled precedence
    return discoverSourceRoots(rootIndex + 1, options, accumulator);
}

async function discoverEntry(options: {
    entry: Dirent;
    rootIndex: number;
    sourceRoot: string;
    appVersion: string;
    includeTestOnly: boolean;
    discoveredIds: ReadonlySet<string>;
}): Promise<EntryDiscoveryResult> {
    const { entry, rootIndex, sourceRoot, appVersion, includeTestOnly, discoveredIds } = options;
    const candidateRoot = join(sourceRoot, entry.name);
    let source: string;
    try {
        source = await readManifestSource(join(candidateRoot, 'package.json'));
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return undefined;
        return {
            kind: 'rejected',
            value: {
                extensionId: rejectedExtensionId(entry.name, rootIndex),
                version: 'unknown',
                error: extensionError(
                    'MANIFEST_INVALID',
                    error instanceof Error ? error.message : String(error),
                ),
            },
        };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(source) as unknown;
    } catch {
        return {
            kind: 'rejected',
            value: {
                extensionId: rejectedExtensionId(entry.name, rootIndex),
                version: 'unknown',
                error: extensionError('MANIFEST_INVALID', 'Extension package.json is invalid JSON'),
            },
        };
    }
    const parsed = extensionManifestSchema.safeParse(raw);
    if (!parsed.success) {
        const candidate = raw as {
            name?: unknown;
            version?: unknown;
            main?: unknown;
            type?: unknown;
        };
        const unsupportedCommonJs =
            candidate.type === 'commonjs' ||
            (typeof candidate.main === 'string' && candidate.main.endsWith('.cjs'));
        const candidateId = extensionIdSchema.safeParse(candidate.name);
        return {
            kind: 'rejected',
            value: {
                extensionId: rejectedExtensionId(entry.name, rootIndex),
                version: rejectedVersion(candidate.version),
                error: extensionError(
                    unsupportedCommonJs ? 'COMMONJS_ENTRY_UNSUPPORTED' : 'MANIFEST_INVALID',
                    parsed.error.issues
                        .map(
                            ({ message, path }) =>
                                `${path.length > 0 ? path.join('.') : 'manifest'}: ${message}`,
                        )
                        .join('; '),
                ),
            },
            ...(rootIndex === 0 &&
                candidateId.success && { reservedExtensionId: candidateId.data }),
        };
    }

    const manifest = parsed.data;
    if (!includeTestOnly && manifest.caxri.testOnly) return undefined;
    if (!isEngineCompatible(manifest.engines.caxri, appVersion))
        return rejectedIdentifiedExtension({
            code: 'ENGINE_INCOMPATIBLE',
            entryName: entry.name,
            rootIndex,
            manifest,
            message: `${manifest.name} requires Caxri ${manifest.engines.caxri}`,
        });
    if (discoveredIds.has(manifest.name))
        return rejectedIdentifiedExtension({
            code: 'DUPLICATE_ID',
            entryName: entry.name,
            rootIndex,
            manifest,
            message: `Duplicate extension id: ${manifest.name}`,
            reserveBundledIdentity: false,
        });

    let rootPath: string;
    let entryPath: string;
    try {
        rootPath = await realpath(candidateRoot);
        entryPath = await realpath(resolve(rootPath, manifest.main));
    } catch {
        return rejectedIdentifiedExtension({
            code: 'MANIFEST_INVALID',
            entryName: entry.name,
            rootIndex,
            manifest,
            message: 'Extension entry is missing or inaccessible',
        });
    }
    if (!isInside(rootPath, entryPath))
        return rejectedIdentifiedExtension({
            code: 'MANIFEST_INVALID',
            entryName: entry.name,
            rootIndex,
            manifest,
            message: 'Extension entry escapes its root',
        });
    return {
        kind: 'extension',
        value: {
            extensionId: manifest.name,
            source: rootIndex === 0 ? 'bundled' : 'installed',
            rootPath,
            entryPath,
            manifest,
        },
    };
}

export async function discoverExtensions(options: DiscoveryOptions): Promise<{
    extensions: DiscoveredExtension[];
    rejected: RejectedExtension[];
}> {
    const extensions: DiscoveredExtension[] = [];
    const rejected: RejectedExtension[] = [];
    const discoveredIds = new Set<string>();
    /**
     * Recursive traversal is deliberate: root and directory precedence defines which duplicate extension id wins.
     * Parallel discovery could let an installed extension race and impersonate an earlier bundled entry.
     */
    await discoverSourceRoots(0, options, { discoveredIds, extensions, rejected });
    return { extensions, rejected };
}

export function extensionRootsForServer(options: {
    serverBundleDirectory: string;
    userDataPath: string;
    resourcesPath?: string;
}): string[] {
    const bundled = options.resourcesPath
        ? join(options.resourcesPath, 'extensions')
        : resolve(options.serverBundleDirectory, '../extensions');
    return [bundled, join(options.userDataPath, 'extensions')];
}
