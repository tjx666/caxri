export type PlatformNeutralCIGateId =
    | 'bundle-budget'
    | 'docs-check'
    | 'em-dash-check'
    | 'eslint'
    | 'format'
    | 'gitleaks'
    | 'knip'
    | 'markdownlint'
    | 'oxlint-type-aware'
    | 'react-doctor'
    | 'source-size-ratchet'
    | 'typescript'
    | 'vitest';

export interface PlatformCheckDefinition {
    arguments: (environment: NodeJS.ProcessEnv) => string[];
    command: string;
    id: PlatformNeutralCIGateId;
    label: string;
    receiptCommand: string;
    /**
     * The gate cannot run on a Linux runner; see {@link MACOS_ONLY_CI_GATE_IDS}.
     */
    requiresMacOS?: true;
}

export interface PlatformCheckCommand {
    arguments: string[];
    command: string;
    id: 'node-pty-preparation' | PlatformNeutralCIGateId;
    label: string;
}

export interface PlatformCheckOptions {
    includeNodePtyPreparation?: boolean;
    /**
     * Gates another job owns. Hosted CI skips `vitest` (the sharded `unit` job), `eslint` (the Linux `lint` job), and
     * `bundle-budget` (the macOS `bundle-budget` job); local fallbacks and the hosted full-E2E route keep every gate.
     */
    skipGates?: readonly PlatformNeutralCIGateId[];
}

interface DirectGateSpec {
    id: PlatformNeutralCIGateId;
    label: string;
    requiresMacOS?: true;
    script: string;
}

interface MetricGateSpec extends DirectGateSpec {
    extraArguments?: (environment: NodeJS.ProcessEnv) => string[];
    metricLabel: (environment: NodeJS.ProcessEnv) => string;
    receiptLabel: string;
    receiptMode?: 'direct' | 'metric';
}

const metricArguments = (label: string, command: string[]): string[] => [
    'run',
    'scripts/ci-metrics.ts',
    '--label',
    label,
    '--',
    ...command,
];

const directGate = ({
    id,
    label,
    requiresMacOS,
    script,
}: DirectGateSpec): PlatformCheckDefinition => ({
    arguments: () => ['run', script],
    command: 'bun',
    id,
    label,
    receiptCommand: `bun run ${script}`,
    ...(requiresMacOS && { requiresMacOS }),
});

const metricGate = ({
    extraArguments,
    id,
    label,
    metricLabel,
    receiptLabel,
    receiptMode = 'metric',
    requiresMacOS,
    script,
}: MetricGateSpec): PlatformCheckDefinition => ({
    arguments: (environment) =>
        metricArguments(metricLabel(environment), [
            'bun',
            'run',
            script,
            ...(extraArguments?.(environment) ?? []),
        ]),
    command: 'bun',
    id,
    label,
    receiptCommand:
        receiptMode === 'direct'
            ? `bun run ${script}`
            : `bun run scripts/ci-metrics.ts --label "${receiptLabel}" -- bun run ${script}`,
    ...(requiresMacOS && { requiresMacOS }),
});

/**
 * This manifest is the single semantic authority for full platform checks. Stable IDs support diagnostics while
 * receiptCommand preserves the exact shell contract used by Go's local CI fallback.
 */
export const PLATFORM_NEUTRAL_CI_GATES = [
    directGate({
        id: 'gitleaks',
        label: 'gitleaks',
        script: 'gitleaks',
    }),
    metricGate({
        extraArguments: (environment) => ['--concurrency', environment.ESLINT_CONCURRENCY ?? 'off'],
        id: 'eslint',
        label: 'ESLint',
        metricLabel: (environment) =>
            `ESLint concurrency=${environment.ESLINT_CONCURRENCY ?? 'off'}`,
        receiptLabel: '',
        receiptMode: 'direct',
        script: 'lint',
    }),
    metricGate({
        id: 'oxlint-type-aware',
        label: 'oxlint type-aware',
        metricLabel: () => 'oxlint type-aware',
        receiptLabel: 'oxlint type-aware',
        script: 'lint:type-aware',
    }),
    directGate({
        id: 'markdownlint',
        label: 'markdownlint',
        script: 'lint:markdown',
    }),
    directGate({
        id: 'docs-check',
        label: 'documentation check',
        script: 'docs-check',
    }),
    directGate({
        id: 'source-size-ratchet',
        label: 'source-size ratchet',
        script: 'source-size-ratchet',
    }),
    directGate({
        id: 'em-dash-check',
        label: 'em-dash check',
        script: 'em-dash-check',
    }),
    directGate({
        id: 'knip',
        label: 'knip',
        script: 'knip',
    }),
    directGate({
        id: 'react-doctor',
        label: 'React Doctor',
        script: 'doctor:changed',
    }),
    directGate({
        id: 'typescript',
        label: 'TypeScript',
        script: 'typecheck',
    }),
    directGate({
        id: 'format',
        label: 'format',
        script: 'format:check',
    }),
    metricGate({
        id: 'vitest',
        label: 'unit and integration tests',
        metricLabel: (environment) => {
            const partition = environment.CAXRI_VITEST_PARTITION ?? 'optimized';
            const workers = environment.CAXRI_VITEST_MAX_WORKERS ?? '2';
            return `Vitest full suite partition=${partition} workers=${workers}`;
        },
        receiptLabel:
            'Vitest full suite partition=${CAXRI_VITEST_PARTITION} workers=${CAXRI_VITEST_MAX_WORKERS}',
        requiresMacOS: true,
        script: 'test',
    }),
    metricGate({
        id: 'bundle-budget',
        label: 'bundle budget',
        metricLabel: () => 'Bundle budget gate',
        receiptLabel: 'Bundle budget gate',
        requiresMacOS: true,
        script: 'scripts/ci-bundle-budget.ts',
    }),
] as const satisfies readonly PlatformCheckDefinition[];

export const PLATFORM_NEUTRAL_CI_COMMANDS: readonly string[] = Object.freeze(
    PLATFORM_NEUTRAL_CI_GATES.map(({ receiptCommand }) => receiptCommand),
);

/**
 * Gates that need the darwin `node-pty` layout or an `electron-builder --mac` package. The Linux full-scope `checks`
 * job must skip each of them; a Linux run that selects one fails before spending time on the other gates.
 */
export const MACOS_ONLY_CI_GATE_IDS: readonly PlatformNeutralCIGateId[] = Object.freeze(
    PLATFORM_NEUTRAL_CI_GATES.filter((gate) => 'requiresMacOS' in gate).map(({ id }) => id),
);

/**
 * Hosted CI runs these gates in their own jobs beside the remaining platform checks.
 */
export const SKIP_GATE_ARGUMENTS: Readonly<Record<string, PlatformNeutralCIGateId>> = {
    '--skip-bundle-budget': 'bundle-budget',
    '--skip-eslint': 'eslint',
    '--skip-vitest': 'vitest',
};

/**
 * Rejects a selection that would run a macOS-only gate on another platform.
 */
export function assertGatesRunOnPlatform(
    gateIds: ReadonlyArray<PlatformCheckCommand['id']>,
    platform: NodeJS.Platform,
): void {
    if (platform === 'darwin') return;
    const unsupported = gateIds.filter((id) =>
        (MACOS_ONLY_CI_GATE_IDS as readonly string[]).includes(id),
    );
    if (unsupported.length > 0)
        throw new Error(
            `These CI gates require macOS and cannot run on ${platform}: ${unsupported.join(', ')}. ` +
                `Skip them with ${Object.keys(SKIP_GATE_ARGUMENTS).join(', ')} and run them in a macOS job.`,
        );
}

export function platformCheckCommands(
    environment: NodeJS.ProcessEnv,
    options: PlatformCheckOptions = {},
): PlatformCheckCommand[] {
    const skipped = new Set(options.skipGates);
    const checks = PLATFORM_NEUTRAL_CI_GATES.filter(({ id }) => !skipped.has(id)).map((gate) => ({
        arguments: gate.arguments(environment),
        command: gate.command,
        id: gate.id,
        label: gate.label,
    }));
    if (options.includeNodePtyPreparation === false) return checks;
    return [
        {
            arguments: ['run', 'scripts/prepare-node-pty.ts'],
            command: 'bun',
            id: 'node-pty-preparation',
            label: 'node-pty spawn helper',
        },
        ...checks,
    ];
}
