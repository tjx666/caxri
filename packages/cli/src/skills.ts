import { createHash, randomUUID } from 'node:crypto';
import { realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { CaxriError } from '@caxri/protocol';

import { CAXRI_SKILL_FILES } from './caxri-skill.generated';
import {
    assertManagedLayoutUnchanged,
    assertSafeLocalTarget,
    inspectManagedSkill,
    installManagedSkill,
    type ManagedSkillBundle,
    type ManagedSkillLayout,
    prepareSkillParent,
    removeManagedSkillTree,
    updateManagedSkill,
    withSkillMutationLock,
} from './skill-filesystem';
import { CLI_PROTOCOL_VERSION, CLI_VERSION } from './version';

const CURRENT_MARKER_SCHEMA = 1;
const MANAGED_BY = 'caxri';
const MARKER_FILE = '.caxri-skill.json';
const MAX_MANAGED_FILES = 16;
const SKILL_NAME = 'caxri-cli';
const managedFileNames = Object.keys(CAXRI_SKILL_FILES).sort();

type SkillInstallScope = 'global' | 'local';
type SkillProvider = 'claude' | 'codex';
type SkillStatus = 'compatible' | 'conflict' | 'missing' | 'stale';

export interface SkillExecutionContext {
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

interface InstalledSkillStatus {
    action: string;
    bundledVersion: string;
    compatible: boolean;
    contentHash?: string;
    installedSchemaVersion?: number;
    installedVersion?: string;
    name: typeof SKILL_NAME;
    protocolVersion: number;
    provider: SkillProvider;
    reason: string;
    repairCommand?: string;
    scope: SkillInstallScope;
    status: SkillStatus;
}

interface InspectedSkill {
    identity?: { dev: bigint; ino: bigint };
    layout?: ManagedSkillLayout;
    marker?: InstalledSkillMarker;
    target: string;
    value: InstalledSkillStatus;
}

function hashFiles(files: Readonly<Record<string, string>>): string {
    const hash = createHash('sha256');
    for (const name of Object.keys(files).sort()) {
        const content = files[name];
        hash.update(`${name}\0${Buffer.byteLength(content)}\0`);
        hash.update(content);
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}

const bundledMetadata: BundledSkillMetadata = Object.freeze({
    bundledVersion: CLI_VERSION,
    compatibility: { cliVersion: CLI_VERSION, protocolVersion: CLI_PROTOCOL_VERSION },
    contentHash: hashFiles(CAXRI_SKILL_FILES),
    files: Object.freeze([...managedFileNames]),
    name: SKILL_NAME,
    schemaVersion: CURRENT_MARKER_SCHEMA,
});

function markerForBundle(): InstalledSkillMarker {
    return {
        contentHash: bundledMetadata.contentHash,
        files: [...bundledMetadata.files],
        installedVersion: CLI_VERSION,
        managedBy: MANAGED_BY,
        name: SKILL_NAME,
        protocolVersion: CLI_PROTOCOL_VERSION,
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
    const configured =
        provider === 'codex'
            ? context.environment.CODEX_HOME
            : context.environment.CLAUDE_CONFIG_DIR;
    if (configured && !isAbsolute(configured))
        throw new CaxriError(
            'VALIDATION',
            `${provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'} must be absolute`,
        );
    return resolve(configured ?? join(context.home, provider === 'codex' ? '.codex' : '.claude'));
}

async function installationTarget(
    context: SkillExecutionContext,
    provider: SkillProvider,
    scope: SkillInstallScope,
): Promise<string> {
    if (scope === 'global') return join(providerRoot(context, provider), 'skills', SKILL_NAME);
    return join(
        await realpath(resolve(context.cwd)),
        provider === 'codex' ? '.agents' : '.claude',
        'skills',
        SKILL_NAME,
    );
}

function commandFor(action: 'install' | 'update', selection: SkillSelection): string {
    return `caxri skills ${action} ${SKILL_NAME} --provider ${selection.provider} --${selection.scope} --yes`;
}

function statusValue(
    selection: SkillSelection,
    status: SkillStatus,
    reason: string,
    action: string,
    marker?: InstalledSkillMarker,
    repairCommand?: string,
): InstalledSkillStatus {
    return {
        action,
        bundledVersion: CLI_VERSION,
        compatible: status === 'compatible',
        ...(marker
            ? {
                  contentHash: marker.contentHash,
                  installedSchemaVersion: marker.schemaVersion,
                  installedVersion: marker.installedVersion,
              }
            : {}),
        name: SKILL_NAME,
        protocolVersion: CLI_PROTOCOL_VERSION,
        provider: selection.provider,
        reason,
        ...(repairCommand ? { repairCommand } : {}),
        scope: selection.scope,
        status,
    };
}

function safeManagedPath(name: string): boolean {
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
        !Number.isInteger(record.protocolVersion) ||
        Number(record.protocolVersion) < 1 ||
        Number(record.protocolVersion) > 1_000_000 ||
        typeof record.installedVersion !== 'string' ||
        record.installedVersion.length > 100 ||
        typeof record.contentHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(record.contentHash) ||
        !Array.isArray(files) ||
        files.length === 0 ||
        files.length > MAX_MANAGED_FILES ||
        !files.every(
            (name) => typeof name === 'string' && name.length <= 240 && safeManagedPath(name),
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
        ...(match[4] ? { prerelease: match[4] } : {}),
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
            rawRecord.installedVersion.length <= 100
                ? rawRecord.installedVersion
                : undefined;
        const value = statusValue(
            selection,
            'conflict',
            Number.isInteger(schemaVersion) ? 'unknown-schema' : 'invalid-marker',
            Number.isInteger(schemaVersion)
                ? `Use a Caxri CLI that supports installed marker schema ${String(schemaVersion)}; this CLI will not overwrite it.`
                : 'Preserve this entry and inspect its invalid Caxri marker manually.',
        );
        return {
            identity: layout.identity,
            layout,
            target,
            value: {
                ...value,
                ...(Number.isInteger(schemaVersion)
                    ? { installedSchemaVersion: Number(schemaVersion) }
                    : {}),
                ...(installedVersion ? { installedVersion } : {}),
            },
        };
    }

    const actualFiles = Object.keys(layout.files).sort();
    const expectedFiles = [...marker.files].sort();
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

    const comparison = compareVersions(marker.installedVersion, CLI_VERSION);
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
        marker.protocolVersion !== CLI_PROTOCOL_VERSION ||
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
    return await withSkillMutationLock(location, async (anchoredTarget) => {
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

/** Executes an offline bundled-skill command without connecting to a Host or exposing local paths. */
export async function executeSkillCommand(
    action: string,
    params: unknown,
    context: SkillExecutionContext,
): Promise<unknown> {
    const input = params as Record<string, unknown>;
    if (action === 'list') return { skills: [bundledMetadata] };
    if (action === 'get') {
        assertBundledName(input.name);
        return {
            ...bundledMetadata,
            ...(input.full === true ? { content: CAXRI_SKILL_FILES['SKILL.md'] } : {}),
        };
    }
    if (action === 'status') {
        const providers: SkillProvider[] = input.provider
            ? [input.provider as SkillProvider]
            : ['codex', 'claude'];
        const scopes: SkillInstallScope[] = input.scope
            ? [input.scope as SkillInstallScope]
            : ['local', 'global'];
        const installations: InstalledSkillStatus[] = [];
        for (const provider of providers) {
            for (const scope of scopes) {
                installations.push(
                    (await inspectSkill({ name: SKILL_NAME, provider, scope }, context)).value,
                );
            }
        }
        return { bundled: bundledMetadata, installations };
    }
    assertBundledName(input.name);
    if (action === 'install' || action === 'update' || action === 'uninstall')
        return await mutateSkill(action, input as unknown as SkillSelection, context);
    throw new CaxriError('VALIDATION', `Unknown skills action: ${action}`);
}
