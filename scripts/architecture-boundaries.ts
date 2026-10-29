type TopologyMigrationBatch = 'A2b' | 'A2c' | 'A2d' | 'A2e' | 'A2f';

export interface AppBoundary {
    allowedPackages: ReadonlyArray<PackageBoundary['id']>;
    id: 'cli' | 'desktop' | 'mobile' | 'relay' | 'server';
    root: `apps/${string}`;
    packageNames: readonly string[];
    testAllowedPackages?: ReadonlyArray<PackageBoundary['id']>;
}

export interface PackageBoundary {
    allowedPackages: ReadonlyArray<PackageBoundary['id']>;
    id:
        | 'agent-skills'
        | 'client'
        | 'extension-api'
        | 'markdown'
        | 'mobile-transport'
        | 'protocol'
        | 'system'
        | 'utils';
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
 * Current topology. An application is independently runnable or deployable and can depend on public package exports,
 * but application source is never an importable implementation boundary.
 */
export const appBoundaries: readonly AppBoundary[] = [
    {
        id: 'desktop',
        root: 'apps/desktop',
        packageNames: ['@caxri/desktop'],
        allowedPackages: ['client', 'markdown', 'protocol', 'system', 'utils'],
    },
    {
        id: 'mobile',
        root: 'apps/mobile',
        packageNames: ['@caxri/mobile'],
        allowedPackages: ['mobile-transport', 'protocol'],
        testAllowedPackages: ['utils'],
    },
    {
        id: 'server',
        root: 'apps/server',
        packageNames: ['@caxri/server'],
        allowedPackages: [
            'agent-skills',
            'extension-api',
            'mobile-transport',
            'protocol',
            'system',
            'utils',
        ],
        testAllowedPackages: ['client'],
    },
    {
        id: 'cli',
        root: 'apps/cli',
        packageNames: ['@caxri/cli'],
        allowedPackages: ['agent-skills', 'client', 'protocol', 'system', 'utils'],
    },
    {
        id: 'relay',
        root: 'apps/relay',
        packageNames: ['@caxri/relay'],
        allowedPackages: ['mobile-transport'],
    },
];

/**
 * Current importable packages and the only subpaths consumers may use.
 */
export const packageBoundaries: readonly PackageBoundary[] = [
    {
        id: 'agent-skills',
        root: 'packages/agent-skills',
        packageNames: ['@caxri/agent-skills'],
        publicSubpaths: ['.', './testing'],
        testOnlySubpaths: ['./testing'],
        browserSafe: false,
        allowedPackages: ['protocol', 'system'],
    },
    {
        id: 'client',
        root: 'packages/client',
        packageNames: ['@caxri/client'],
        publicSubpaths: ['.', './connection', './state', './supervise'],
        browserSafe: true,
        allowedPackages: ['protocol', 'system', 'utils'],
        browserUnsafeSourceRoots: ['packages/client/src/supervise'],
    },
    {
        id: 'markdown',
        root: 'packages/markdown',
        packageNames: ['@caxri/markdown'],
        publicSubpaths: ['.'],
        browserSafe: true,
        allowedPackages: [],
    },
    {
        id: 'mobile-transport',
        root: 'packages/mobile-transport',
        packageNames: ['@caxri/mobile-transport'],
        publicSubpaths: ['.'],
        browserSafe: true,
        allowedPackages: [],
    },
    {
        id: 'protocol',
        root: 'packages/protocol',
        packageNames: ['@caxri/protocol'],
        publicSubpaths: ['.'],
        browserSafe: true,
        allowedPackages: ['utils'],
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
        id: 'system',
        root: 'packages/system',
        packageNames: ['@caxri/system'],
        publicSubpaths: ['.'],
        browserSafe: false,
        allowedPackages: ['protocol', 'utils'],
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
 * Legacy production roots retained only until their owning move. The completed cutover keeps this list empty so lint
 * and contract tests cannot silently reintroduce a transitional directory.
 */
export const legacyOwnershipRoots: readonly LegacyOwnershipRoot[] = [];

/**
 * Temporary cross-boundary imports. A2b eliminated every allowance it inherited; later topology moves may remove the
 * remaining ownership roots without weakening import policy.
 */
export const transitionalImportAllowances: readonly TransitionalImportAllowance[] = [];

export const transitionalCycleAllowances: readonly TransitionalCycleAllowance[] = [];

/**
 * Server Core and the Client supervisor talk to their processes over stdio and the Server's control connection, never a
 * local TCP or Unix-domain control socket. Only these files may import `node:net`: the Mobile gateway owns the one TCP
 * listener (its options and admission modules share its `Socket` type), the Mobile preview proxy serves on the gateway
 * address and relays WebSocket upgrades to a loopback dev server, and the Linux profile lock binds an abstract socket
 * only as a kernel-owned mutex that never accepts a control connection.
 */
export const netSocketRoots = ['apps/server/src/core', 'packages/client/src/supervise'] as const;

export const netSocketImporters: readonly string[] = [
    'apps/server/src/core/linux-profile-lock.ts',
    'apps/server/src/core/mobile/gateway/admission.ts',
    'apps/server/src/core/mobile/gateway/gateway-options.ts',
    'apps/server/src/core/mobile/gateway/gateway.ts',
    'apps/server/src/core/mobile/preview/proxy.ts',
];

export const browserUnsafeImports = [
    'electron',
    'node-pty',
    'better-sqlite3',
    '@parcel/watcher',
    'ws',
] as const;
