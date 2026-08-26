type TopologyMigrationBatch = 'A2b' | 'A2c' | 'A2d' | 'A2e' | 'A2f';

export interface AppBoundary {
    allowedPackages: ReadonlyArray<PackageBoundary['id']>;
    id: 'cli' | 'desktop' | 'server';
    root: `apps/${string}`;
    packageNames: readonly string[];
    testAllowedPackages?: ReadonlyArray<PackageBoundary['id']>;
}

export interface PackageBoundary {
    allowedPackages: ReadonlyArray<PackageBoundary['id']>;
    id: 'agent-skills' | 'client' | 'extension-api' | 'protocol' | 'utils';
    root: `packages/${string}`;
    packageNames: readonly string[];
    publicSubpaths: readonly string[];
    testOnlySubpaths?: readonly string[];
    browserSafe: boolean;
    browserUnsafeSourceRoots?: readonly string[];
}

export interface LegacyOwnershipRoot {
    root: string;
    kind: 'application' | 'package' | 'shared';
    owner: string;
    removeInBatch: TopologyMigrationBatch;
    target: string;
}

export interface TransitionalImportAllowance {
    id: string;
    importer: string;
    specifiers: readonly string[];
    removeInBatch: TopologyMigrationBatch;
    rationale: string;
}

export interface TransitionalCycleAllowance {
    id: string;
    files: readonly string[];
    removeInBatch: TopologyMigrationBatch;
    rationale: string;
}

/**
 * Target topology. An application is independently runnable or deployable and can depend on public package exports, but
 * application source is never an importable implementation boundary.
 */
export const appBoundaries: readonly AppBoundary[] = [
    {
        id: 'desktop',
        root: 'apps/desktop',
        packageNames: ['@caxri/desktop'],
        allowedPackages: ['client', 'protocol', 'utils'],
    },
    {
        id: 'server',
        root: 'apps/server',
        packageNames: ['@caxri/server'],
        allowedPackages: ['agent-skills', 'extension-api', 'protocol', 'utils'],
        testAllowedPackages: ['client'],
    },
    {
        id: 'cli',
        root: 'apps/cli',
        packageNames: ['@caxri/cli'],
        allowedPackages: ['agent-skills', 'client', 'protocol', 'utils'],
    },
];

/**
 * Importable target packages and the only subpaths consumers may use.
 */
export const packageBoundaries: readonly PackageBoundary[] = [
    {
        id: 'agent-skills',
        root: 'packages/agent-skills',
        packageNames: ['@caxri/agent-skills'],
        publicSubpaths: ['.', './testing'],
        testOnlySubpaths: ['./testing'],
        browserSafe: false,
        allowedPackages: ['protocol'],
    },
    {
        id: 'client',
        root: 'packages/client',
        packageNames: ['@caxri/client'],
        publicSubpaths: ['.', './connection', './state', './supervise'],
        browserSafe: true,
        allowedPackages: ['protocol', 'utils'],
        browserUnsafeSourceRoots: ['packages/client/src/supervise'],
    },
    {
        id: 'protocol',
        root: 'packages/protocol',
        packageNames: ['@caxri/protocol'],
        publicSubpaths: ['.'],
        browserSafe: true,
        allowedPackages: [],
    },
    {
        id: 'extension-api',
        root: 'packages/extension-api',
        packageNames: ['caxri'],
        publicSubpaths: ['.'],
        browserSafe: true,
        allowedPackages: [],
    },
    {
        id: 'utils',
        root: 'packages/utils',
        packageNames: ['@caxri/utils'],
        publicSubpaths: ['.'],
        browserSafe: true,
        allowedPackages: [],
    },
];

/**
 * Current production roots remain authoritative only until their owning move. The list is data so lint and contract
 * tests cannot silently turn a transitional directory into permanent architecture.
 */
export const legacyOwnershipRoots: readonly LegacyOwnershipRoot[] = [
    {
        root: 'src/host',
        kind: 'application',
        owner: 'server',
        removeInBatch: 'A2e',
        target: 'apps/server/src/core',
    },
    {
        root: 'src/runtime',
        kind: 'application',
        owner: 'server',
        removeInBatch: 'A2e',
        target: 'apps/server/src/runtime',
    },
    {
        root: 'src/extension-host',
        kind: 'application',
        owner: 'server',
        removeInBatch: 'A2e',
        target: 'apps/server/src/extension-host',
    },
    {
        root: 'src/shared/node',
        kind: 'shared',
        owner: 'application-specific-node-support',
        removeInBatch: 'A2e',
        target: 'apps/desktop or apps/server owning module',
    },
    {
        root: 'src/shared',
        kind: 'shared',
        owner: 'unassigned-shared-source',
        removeInBatch: 'A2e',
        target: 'packages or owning application',
    },
];

/**
 * Temporary cross-boundary imports. A2b eliminated every allowance it inherited; later topology moves may remove the
 * remaining ownership roots without weakening import policy.
 */
export const transitionalImportAllowances: readonly TransitionalImportAllowance[] = [];

export const transitionalCycleAllowances: readonly TransitionalCycleAllowance[] = [];

export const browserUnsafeImports = [
    'electron',
    'node-pty',
    'better-sqlite3',
    '@parcel/watcher',
    'ws',
] as const;
