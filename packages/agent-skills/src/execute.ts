import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type {
    AgentProvider,
    AgentSkillHealth,
    AgentSkillInstallationHealth,
    AgentSkillScope,
} from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';

import { CAXRI_SKILL_FILES } from './caxri-skill.generated.js';
import type { ManagedSkillBundle, ManagedSkillLayout } from './filesystem.js';
import {
    assertManagedLayoutUnchanged,
    assertSafeLocalTarget,
    inspectManagedSkill,
    installManagedSkill,
    prepareSkillParent,
    removeManagedSkillTree,
    updateManagedSkill,
    withSkillMutationLock,
} from './filesystem.js';
import { agentSkillProviderIds, requireAgentSkillProviderIntegration } from './provider-policy.js';
import { SKILL_BUNDLE_VERSION } from './version.js';

const CURRENT_MARKER_SCHEMA = 1;
const MANAGED_BY = 'caxri';
const MARKER_FILE = '.caxri-skill.json';
const MAX_MANAGED_FILES = 16;
const SKILL_NAME = 'caxri-cli';
const managedFileNames = Object.keys(CAXRI_SKILL_FILES).toSorted((left, right) =>
    left.localeCompare(right),
);

type SkillInstallScope = AgentSkillScope;
type SkillProvider = AgentProvider;

interface SkillExecutionContext {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    home: string;
}

interface SkillSelection {
    name: typeof SKILL_NAME;
    provider: SkillProvider;
    scope: SkillInstallScope;
}

interface InstalledSkillMarker {
    contentHash: string;
    files: string[];
    installedVersion: string;
    managedBy: typeof MANAGED_BY;
    name: typeof SKILL_NAME;
    protocolVersion: number;
    schemaVersion: typeof CURRENT_MARKER_SCHEMA;
}

interface BundledSkillMetadata {
    bundledVersion: string;
    compatibility: {
        cliVersion: string;
        protocolVersion: number;
    };
    contentHash: string;
    files: readonly string[];
    name: typeof SKILL_NAME;
    schemaVersion: number;
}

type InstalledSkillStatus = AgentSkillInstallationHealth;

interface InspectedSkill {
    identity?: { dev: bigint; ino: bigint };
    layout?: ManagedSkillLayout;
    marker?: InstalledSkillMarker;
    target: string;
    value: InstalledSkillStatus;
}

function hashFiles(files: Readonly<Record<string, string>>): string {
    const hash = createHash('sha256');
    const names = Object.keys(files).toSorted((left, right) => left.localeCompare(right));
    for (const name of names) {
        const content = files[name];
        hash.update(`${name}\0${Buffer.byteLength(content)}\0`);
        hash.update(content);
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}

const bundledMetadata: BundledSkillMetadata = Object.freeze({
    bundledVersion: SKILL_BUNDLE_VERSION,
    compatibility: {
        cliVersion: SKILL_BUNDLE_VERSION,
        protocolVersion: CAXRI_PROTOCOL_VERSION,
    },
    contentHash: hashFiles(CAXRI_SKILL_FILES),
    files: Object.freeze([...managedFileNames]),
    name: SKILL_NAME,
    schemaVersion: CURRENT_MARKER_SCHEMA,
});

function markerForBundle(): InstalledSkillMarker {
    return {
        contentHash: bundledMetadata.contentHash,
        files: [...bundledMetadata.files],
        installedVersion: SKILL_BUNDLE_VERSION,
        managedBy: MANAGED_BY,
        name: SKILL_NAME,
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        schemaVersion: CURRENT_MARKER_SCHEMA,
    };
}

function managedBundle(): ManagedSkillBundle {
    return {
        files: CAXRI_SKILL_FILES,
        marker: `${JSON.stringify(markerForBundle(), null, 2)}\n`,
        name: SKILL_NAME,
    };
}

function providerRoot(context: SkillExecutionContext, provider: SkillProvider): string {
    const integration = requireAgentSkillProviderIntegration(provider);
    const variable = integration.configEnvironmentVariable;
    const configured = variable ? context.environment[variable] : undefined;
    if (configured && !isAbsolute(configured))
        throw new CaxriError('VALIDATION', `${variable} must be absolute`);
    return resolve(configured ?? join(context.home, integration.defaultConfigDirectory));
}

async function installationTarget(
    context: SkillExecutionContext,
    provider: SkillProvider,
    scope: SkillInstallScope,
): Promise<string> {
    if (scope === 'global') return join(providerRoot(context, provider), 'skills', SKILL_NAME);
    const integration = requireAgentSkillProviderIntegration(provider);
    return join(
        await realpath(resolve(context.cwd)),
        integration.localSkillsDirectory,
        'skills',
        SKILL_NAME,
    );
}

function commandFor(action: 'install' | 'update', selection: SkillSelection): string {
    return `caxri skills ${action} ${SKILL_NAME} --provider ${selection.provider} --${selection.scope} --yes`;
}

function statusValue(
    selection: SkillSelection,
    status: InstalledSkillStatus['status'],
    reason: InstalledSkillStatus['reason'],
    action: string,
    marker?: InstalledSkillMarker,
    repairCommand?: string,
): InstalledSkillStatus {
    return {
        action,
        bundledVersion: SKILL_BUNDLE_VERSION,
        compatible: status === 'compatible',
        ...(marker && {
            contentHash: marker.contentHash,
            installedSchemaVersion: marker.schemaVersion,
            installedVersion: marker.installedVersion,
        }),
        name: SKILL_NAME,
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        provider: selection.provider,
        reason,
        ...(repairCommand && { repairCommand }),
        scope: selection.scope,
        status,
    };
}

function isSafeManagedPath(name: string): boolean {
    if (!name || name.startsWith('/') || name.includes('\0') || name.split('/').includes('..'))
        return false;
    const normalized = name.split('/').filter(Boolean).join('/');
    return normalized === name && name !== MARKER_FILE;
}

function parseMarker(source: string): InstalledSkillMarker | undefined {
    let value: unknown;
    try {
        value = JSON.parse(source) as unknown;
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const files = record.files;
    if (
        record.schemaVersion !== CURRENT_MARKER_SCHEMA ||
        record.managedBy !== MANAGED_BY ||
        record.name !== SKILL_NAME ||
        !Number.isSafeInteger(record.protocolVersion) ||
        Number(record.protocolVersion) < 1 ||
        Number(record.protocolVersion) > 1_000_000 ||
        typeof record.installedVersion !== 'string' ||
        record.installedVersion.length > 100 ||
        typeof record.contentHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(record.contentHash) ||
        !Array.isArray(files) ||
        files.length === 0 ||
        files.length > MAX_MANAGED_FILES ||
        files.some(
            (name) => !(typeof name === 'string' && name.length <= 240 && isSafeManagedPath(name)),
        ) ||
        new Set(files).size !== files.length
    )
        return undefined;
    return record as unknown as InstalledSkillMarker;
}

interface Semver {
    core: readonly [number, number, number];
    prerelease?: string;
}

function semver(source: string): Semver | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(source);
    if (!match) return undefined;
    return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        ...(match[4] && { prerelease: match[4] }),
    };
}

function compareVersions(left: string, right: string): number | undefined {
    const a = semver(left);
    const b = semver(right);
    if (!a || !b) return undefined;
    for (let index = 0; index < a.core.length; index += 1) {
        if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
    }
    if (a.prerelease === b.prerelease) return 0;
    if (!a.prerelease) return 1;
    if (!b.prerelease) return -1;
    return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

async function inspectSkill(
    selection: SkillSelection,
    context: SkillExecutionContext,
    knownTarget?: string,
): Promise<InspectedSkill> {
    const target =
        knownTarget ?? (await installationTarget(context, selection.provider, selection.scope));
    if (selection.scope === 'local' && isAbsolute(target)) {
        try {
            await assertSafeLocalTarget(context.cwd, target);
        } catch (error) {
            if (!(error instanceof CaxriError)) throw error;
            return {
                target,
                value: statusValue(
                    selection,
                    'conflict',
                    'unsafe-parent',
                    'Preserve the linked Provider directory; choose a safe Project root or global scope.',
                ),
            };
        }
    }
    const filesystem = await inspectManagedSkill(target, managedBundle());
    if (filesystem.kind === 'missing')
        return {
            target,
            value: statusValue(
                selection,
                'missing',
                'not-installed',
                'Install the bundled skill into this explicit Provider scope.',
                undefined,
                commandFor('install', selection),
            ),
        };
    if (filesystem.kind === 'foreign')
        return {
            identity: filesystem.identity,
            target,
            value: statusValue(
                selection,
                'conflict',
                filesystem.reason,
                'Preserve this entry; Caxri will not overwrite or remove an unmarked skill.',
            ),
        };
    if (filesystem.kind === 'invalid')
        return {
            identity: filesystem.identity,
            target,
            value: statusValue(
                selection,
                'conflict',
                filesystem.reason,
                'Preserve this Caxri-marked entry and inspect its layout manually.',
            ),
        };

    const { layout } = filesystem;
    const { markerSource } = layout;
    let rawMarker: unknown;
    try {
        rawMarker = JSON.parse(markerSource) as unknown;
    } catch {
        rawMarker = undefined;
    }
    const marker = parseMarker(markerSource);
    if (!marker) {
        const rawRecord =
            typeof rawMarker === 'object' && rawMarker !== null
                ? (rawMarker as Record<string, unknown>)
                : undefined;
        const schemaVersion = rawRecord === undefined ? undefined : rawRecord.schemaVersion;
        const installedVersion =
            typeof rawRecord?.installedVersion === 'string' &&
            rawRecord.installedVersion.length > 0 &&
            rawRecord.installedVersion.length <= 100 &&
            semver(rawRecord.installedVersion)
                ? rawRecord.installedVersion
                : undefined;
        const value = statusValue(
            selection,
            'conflict',
            Number.isSafeInteger(schemaVersion) ? 'unknown-schema' : 'invalid-marker',
            Number.isSafeInteger(schemaVersion)
                ? `Use a Caxri CLI that supports installed marker schema ${String(schemaVersion)}; this CLI will not overwrite it.`
                : 'Preserve this entry and inspect its invalid Caxri marker manually.',
        );
        return {
            identity: layout.identity,
            layout,
            target,
            value: {
                ...value,
                ...(Number.isSafeInteger(schemaVersion) &&
                    Number(schemaVersion) >= 1 &&
                    Number(schemaVersion) <= 1_000_000 && {
                        installedSchemaVersion: Number(schemaVersion),
                    }),
                ...(installedVersion && { installedVersion }),
            },
        };
    }

    const actualFiles = Object.keys(layout.files).toSorted((left, right) =>
        left.localeCompare(right),
    );
    const expectedFiles = marker.files.toSorted((left, right) => left.localeCompare(right));
    if (
        actualFiles.join('\0') !== expectedFiles.join('\0') ||
        hashFiles(layout.files) !== marker.contentHash
    )
        return {
            identity: layout.identity,
            layout,
            marker,
            target,
            value: statusValue(
                selection,
                'conflict',
                'modified-or-foreign-files',
                'Preserve this modified entry; back it up and remove it manually before reinstalling.',
                marker,
            ),
        };

    const comparison = compareVersions(marker.installedVersion, SKILL_BUNDLE_VERSION);
    if (comparison === undefined)
        return {
            identity: layout.identity,
            layout,
            marker,
            target,
            value: statusValue(
                selection,
                'conflict',
                'invalid-installed-version',
                'Use a matching Caxri CLI or inspect the marked installation manually.',
                marker,
            ),
        };
    if (comparison > 0)
        return {
            identity: layout.identity,
            layout,
            marker,
            target,
            value: statusValue(
                selection,
                'conflict',
                'newer-version',
                `Use Caxri CLI ${marker.installedVersion} or newer; this CLI will not downgrade it.`,
                marker,
            ),
        };
    if (comparison < 0)
        return {
            identity: layout.identity,
            layout,
            marker,
            target,
            value: statusValue(
                selection,
                'stale',
                'older-version',
                'Update this intact Caxri-managed skill to the bundled version.',
                marker,
                commandFor('update', selection),
            ),
        };
    if (
        marker.protocolVersion !== CAXRI_PROTOCOL_VERSION ||
        marker.contentHash !== bundledMetadata.contentHash ||
        marker.files.join('\0') !== bundledMetadata.files.join('\0')
    )
        return {
            identity: layout.identity,
            layout,
            marker,
            target,
            value: statusValue(
                selection,
                'conflict',
                'same-version-contract-mismatch',
                'Preserve this conflicting same-version skill and reinstall only after manual inspection.',
                marker,
            ),
        };
    return {
        identity: layout.identity,
        layout,
        marker,
        target,
        value: statusValue(
            selection,
            'compatible',
            'matches-bundle',
            'No action is required.',
            marker,
        ),
    };
}

async function restoreMovedInstallation(source: string, target: string): Promise<void> {
    try {
        await rename(source, target);
    } catch {
        throw new CaxriError(
            'CONFLICT',
            'The skill installation changed during this operation; the preserved entry needs manual recovery.',
        );
    }
}

async function mutateSkill(
    operation: 'install' | 'uninstall' | 'update',
    selection: SkillSelection,
    context: SkillExecutionContext,
): Promise<{ changed: boolean; operation: string; skill: InstalledSkillStatus }> {
    const target = await installationTarget(context, selection.provider, selection.scope);
    const location = await prepareSkillParent(
        target,
        selection.scope === 'local' ? context.cwd : undefined,
    );
    return withSkillMutationLock(location, async (anchoredTarget) => {
        const inspection = await inspectSkill(selection, context, anchoredTarget);
        if (operation === 'uninstall') {
            if (inspection.value.status === 'missing')
                return { changed: false, operation, skill: inspection.value };
            if (
                (inspection.value.status !== 'compatible' && inspection.value.status !== 'stale') ||
                !inspection.layout
            )
                throw new CaxriError('CONFLICT', inspection.value.action);
            const removed = `.caxri-cli-remove-${randomUUID()}`;
            await rename(inspection.target, removed);
            try {
                await assertManagedLayoutUnchanged(removed, inspection.layout, managedBundle());
            } catch (error) {
                await restoreMovedInstallation(removed, inspection.target);
                throw error;
            }
            await removeManagedSkillTree(removed, inspection.layout);
            return {
                changed: true,
                operation,
                skill: (await inspectSkill(selection, context, anchoredTarget)).value,
            };
        }
        if (inspection.value.status === 'compatible')
            return { changed: false, operation, skill: inspection.value };
        if (operation === 'install' && inspection.value.status !== 'missing')
            throw new CaxriError(
                'CONFLICT',
                inspection.value.status === 'stale'
                    ? `The installed skill is stale; run ${commandFor('update', selection)}`
                    : inspection.value.action,
            );
        if (operation === 'update' && inspection.value.status !== 'stale')
            throw new CaxriError(
                'CONFLICT',
                inspection.value.status === 'missing'
                    ? `The skill is not installed; run ${commandFor('install', selection)}`
                    : inspection.value.action,
            );
        if (operation === 'install') await installManagedSkill(anchoredTarget, managedBundle());
        else {
            if (!inspection.layout)
                throw new CaxriError(
                    'CONFLICT',
                    'The skill installation is not safely Caxri-managed',
                );
            await updateManagedSkill(inspection.layout, managedBundle());
        }
        return {
            changed: true,
            operation,
            skill: (await inspectSkill(selection, context, anchoredTarget)).value,
        };
    });
}

function assertBundledName(name: unknown): asserts name is typeof SKILL_NAME {
    if (name !== SKILL_NAME) throw new CaxriError('NOT_FOUND', 'Bundled skill was not found');
}

interface SkillHealthSelection {
    providers?: readonly SkillProvider[];
    scopes?: readonly SkillInstallScope[];
}

/**
 * Uses the same bounded marker and content inspection as the offline CLI while returning only the path-free health
 * projection that Desktop Settings may expose over typed IPC.
 */
export async function inspectBundledSkillHealth(
    context: SkillExecutionContext,
    selection: SkillHealthSelection = {},
): Promise<AgentSkillHealth> {
    const providers = selection.providers ?? agentSkillProviderIds;
    const scopes = selection.scopes ?? ['local', 'global'];
    const installations = await Promise.all(
        providers.flatMap((provider) =>
            scopes.map(async (scope) => {
                const inspection = await inspectSkill(
                    { name: SKILL_NAME, provider, scope },
                    context,
                );
                return inspection.value;
            }),
        ),
    );
    return {
        bundled: {
            ...bundledMetadata,
            compatibility: { ...bundledMetadata.compatibility },
            files: [...bundledMetadata.files],
        },
        installations,
    };
}

/**
 * Executes an offline bundled-skill command without connecting to a Host or exposing local paths.
 */
export async function executeSkillCommand(
    action: string,
    parameters: unknown,
    context: SkillExecutionContext,
): Promise<unknown> {
    if (action === 'list') return { skills: [bundledMetadata] };
    const input = parameters as Record<string, unknown>;
    if (action === 'get') {
        assertBundledName(input.name);
        return {
            ...bundledMetadata,
            ...(input.full === true && { content: CAXRI_SKILL_FILES['SKILL.md'] }),
        };
    }
    if (action === 'status') {
        const providers: SkillProvider[] = input.provider
            ? [input.provider as SkillProvider]
            : [...agentSkillProviderIds];
        const scopes: SkillInstallScope[] = input.scope
            ? [input.scope as SkillInstallScope]
            : ['local', 'global'];
        return inspectBundledSkillHealth(context, { providers, scopes });
    }
    assertBundledName(input.name);
    const mutationActions: readonly string[] = ['install', 'update', 'uninstall'];
    if (mutationActions.includes(action))
        return mutateSkill(
            action as 'install' | 'update' | 'uninstall',
            input as unknown as SkillSelection,
            context,
        );
    throw new CaxriError('VALIDATION', `Unknown skills action: ${action}`);
}
