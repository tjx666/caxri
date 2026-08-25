type TopologyMigrationBatch = 'A2b' | 'A2c' | 'A2d' | 'A2e' | 'A2f';

export interface AppBoundary {
    allowedPackages: ReadonlyArray<PackageBoundary['id']>;
    id: 'cli' | 'desktop' | 'server';
    root: `apps/${string}`;
    packageNames: readonly string[];
}

export interface PackageBoundary {
    allowedPackages: ReadonlyArray<PackageBoundary['id']>;
    id: 'client' | 'extension-api' | 'protocol' | 'utils';
    root: `packages/${string}`;
    packageNames: readonly string[];
    publicSubpaths: readonly string[];
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
        allowedPackages: ['extension-api', 'protocol', 'utils'],
    },
    {
        id: 'cli',
        root: 'apps/cli',
        packageNames: ['@caxri/cli'],
        allowedPackages: ['client', 'protocol', 'utils'],
    },
];

/**
 * Importable target packages and the only subpaths consumers may use.
 */
export const packageBoundaries: readonly PackageBoundary[] = [
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
        root: 'packages/cli',
        kind: 'application',
        owner: 'cli',
        removeInBatch: 'A2c',
        target: 'apps/cli',
    },
    {
        root: 'packages/api',
        kind: 'package',
        owner: 'extension-api',
        removeInBatch: 'A2b',
        target: 'packages/extension-api',
    },
    {
        root: 'src/main',
        kind: 'application',
        owner: 'desktop',
        removeInBatch: 'A2d',
        target: 'apps/desktop/src/main',
    },
    {
        root: 'src/preload',
        kind: 'application',
        owner: 'desktop',
        removeInBatch: 'A2d',
        target: 'apps/desktop/src/preload',
    },
    {
        root: 'src/renderer',
        kind: 'application',
        owner: 'desktop',
        removeInBatch: 'A2d',
        target: 'apps/desktop/src/renderer',
    },
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
        root: 'src/shared/ipc',
        kind: 'package',
        owner: 'protocol',
        removeInBatch: 'A2b',
        target: 'packages/protocol',
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
 * Exact existing imports that violate the target graph. Application-to-application allowances always name one file and
 * one reviewed specifier; wildcard application edges are intentionally impossible in this schema.
 */
export const transitionalImportAllowances: readonly TransitionalImportAllowance[] = [
    {
        id: 'desktop-host-client',
        importer: 'src/main/host-connection.ts',
        specifiers: ['@caxri/cli'],
        removeInBatch: 'A2b',
        rationale:
            'The reusable Host client moves from the legacy CLI application into @caxri/client.',
    },
    {
        id: 'desktop-host-client-test',
        importer: 'src/main/__tests__/host-connection.test.ts',
        specifiers: ['@caxri/cli'],
        removeInBatch: 'A2b',
        rationale: 'The test follows the reusable Host client into @caxri/client.',
    },
    {
        id: 'server-agent-skill-client',
        importer: 'src/runtime/agent-skills.ts',
        specifiers: ['@caxri/cli'],
        removeInBatch: 'A2b',
        rationale: 'Agent skill inspection moves behind a reusable package boundary.',
    },
    {
        id: 'server-agent-skill-client-test',
        importer: 'src/runtime/__tests__/agent-skills.integration.test.ts',
        specifiers: ['../../../packages/cli/src/skills'],
        removeInBatch: 'A2b',
        rationale: 'The integration test follows the extracted reusable skill client.',
    },
    {
        id: 'server-control-client-test',
        importer: 'src/host/__tests__/local-server.test.ts',
        specifiers: ['../../../packages/cli/src/host'],
        removeInBatch: 'A2b',
        rationale: 'The transport test consumes @caxri/client after client extraction.',
    },
    {
        id: 'server-control-regression-client-test',
        importer: 'src/host/__tests__/local-server-regressions.test.ts',
        specifiers: ['../../../packages/cli/src/host'],
        removeInBatch: 'A2b',
        rationale: 'The transport regression test consumes @caxri/client after client extraction.',
    },
    {
        id: 'server-app-client-test',
        importer: 'src/host/__tests__/app.integration.test.ts',
        specifiers: ['../../../packages/cli/src/host'],
        removeInBatch: 'A2b',
        rationale: 'The Server integration test consumes @caxri/client after client extraction.',
    },
    {
        id: 'extension-builder-protocol-source',
        importer: 'scripts/build-extension.ts',
        specifiers: ['../packages/protocol/src/index.ts'],
        removeInBatch: 'A2b',
        rationale:
            'The extension builder switches to the public protocol export after package seams are complete.',
    },
    {
        id: 'git-extension-utils',
        importer: 'extensions/git/src/source-control-history.ts',
        specifiers: ['@caxri/utils'],
        removeInBatch: 'A2b',
        rationale: 'The Git Extension takes ownership of its presentation helpers in A2b.',
    },
    protocolPrivateImport(
        'host-runtime-supervisor-protocol',
        'src/host/runtime-supervisor.ts',
        '../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'host-dispatch-type-test-protocol',
        'src/host/__tests__/dispatch-types.test.ts',
        '../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'host-app-test-protocol',
        'src/host/__tests__/app.integration.test.ts',
        '../../../packages/protocol/src',
    ),
    protocolPrivateImport(
        'host-agent-registry-protocol',
        'src/host/agent-endpoints/registry.ts',
        '../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'host-agent-inbox-test-protocol',
        'src/host/agent-inbox/__tests__/registry.test.ts',
        '../../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'host-extension-catalog-test-protocol',
        'src/host/extensions/__tests__/catalog.test.ts',
        '../../../../packages/protocol/src/domain/views',
    ),
    protocolPrivateImport(
        'host-extension-discovery-test-protocol',
        'src/host/extensions/__tests__/discovery.test.ts',
        '../../../../packages/protocol/src/domain/views',
    ),
    protocolPrivateImport(
        'host-extension-service-test-protocol',
        'src/host/extensions/__tests__/service.test.ts',
        '../../../../packages/protocol/src/domain/domain',
    ),
    protocolPrivateImport(
        'host-provider-messaging-test-protocol',
        'src/host/provider-messaging/__tests__/registry.test.ts',
        '../../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'runtime-agent-skills-test-protocol',
        'src/runtime/__tests__/agent-skills.integration.test.ts',
        '../../../packages/protocol/src',
    ),
    protocolPrivateImport(
        'runtime-agent-dispatch-test-protocol',
        'src/runtime/agent-dispatch/__tests__/integration.test.ts',
        '../../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'runtime-agent-lifecycle-test-protocol',
        'src/runtime/agent-endpoints/__tests__/lifecycle.test.ts',
        '../../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'runtime-agent-control-client-protocol',
        'src/runtime/agent-endpoints/control-client.ts',
        '../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'runtime-agent-lifecycle-protocol',
        'src/runtime/agent-endpoints/lifecycle.ts',
        '../../../packages/protocol/src/agent/agent-endpoint-control',
    ),
    protocolPrivateImport(
        'shared-agents-protocol',
        'src/shared/agents.ts',
        '../../packages/protocol/src/agent/agents',
    ),
    protocolPrivateImport(
        'shared-config-contract-protocol',
        'src/shared/config-contract.ts',
        '../../packages/protocol/src/configuration/configuration-contract',
    ),
    protocolPrivateImport('shared-config-protocol', 'src/shared/config.ts', [
        '../../packages/protocol/src/configuration/settings-schema',
        '../../packages/protocol/src/configuration/settings-spec',
    ]),
    protocolPrivateImport(
        'shared-extension-host-protocol',
        'src/shared/extension-host-protocol.ts',
        '../../packages/protocol/src',
    ),
    protocolPrivateImport(
        'shared-project-customization-protocol',
        'src/shared/project-customization.ts',
        '../../packages/protocol/src/domain/project-customization',
    ),
    protocolPrivateImport(
        'shared-renderer-error-protocol',
        'src/shared/renderer-error.ts',
        '../../packages/protocol/src/transport/renderer-error',
    ),
    protocolPrivateImport(
        'shared-trusted-domains-protocol',
        'src/shared/trusted-domains.ts',
        '../../packages/protocol/src/configuration/trusted-domains',
    ),
    protocolPrivateImport(
        'shared-types-protocol',
        'src/shared/types.ts',
        '../../packages/protocol/src/agent/agent-skill-contract',
    ),
    protocolPrivateImport(
        'shared-views-protocol',
        'src/shared/views.ts',
        '../../packages/protocol/src/domain/views',
    ),
];

/**
 * The only pre-existing package cycle; A2b must split the registry type dependency and remove this exception.
 */
export const transitionalCycleAllowances: readonly TransitionalCycleAllowance[] = [
    {
        id: 'protocol-method-registry',
        files: [
            'packages/protocol/src/registry/method-types.ts',
            'packages/protocol/src/registry/methods.ts',
        ],
        removeInBatch: 'A2b',
        rationale: 'Method type derivation currently imports the registry that consumes it.',
    },
];

export const browserUnsafeImports = [
    'electron',
    'node-pty',
    'better-sqlite3',
    '@parcel/watcher',
    'ws',
] as const;

function protocolPrivateImport(
    id: string,
    importer: string,
    specifiers: string | readonly string[],
): TransitionalImportAllowance {
    return {
        id,
        importer,
        specifiers: typeof specifiers === 'string' ? [specifiers] : specifiers,
        removeInBatch: 'A2b',
        rationale: 'The consumer switches to the public protocol export in A2b.',
    };
}
