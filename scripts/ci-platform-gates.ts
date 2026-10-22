type PlatformNeutralCIGateId =
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
     * Defaults to true. Hosted CI passes false because its sharded `unit` job owns the Vitest gate.
     */
    includeVitest?: boolean;
}

interface DirectGateSpec {
    id: PlatformNeutralCIGateId;
    label: string;
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

const directGate = ({ id, label, script }: DirectGateSpec): PlatformCheckDefinition => ({
    arguments: () => ['run', script],
    command: 'bun',
    id,
    label,
    receiptCommand: `bun run ${script}`,
});

const metricGate = ({
    extraArguments,
    id,
    label,
    metricLabel,
    receiptLabel,
    receiptMode = 'metric',
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
        script: 'test',
    }),
    metricGate({
        id: 'bundle-budget',
        label: 'bundle budget',
        metricLabel: () => 'Bundle budget gate',
        receiptLabel: 'Bundle budget gate',
        script: 'scripts/ci-bundle-budget.ts',
    }),
] as const satisfies readonly PlatformCheckDefinition[];

export const PLATFORM_NEUTRAL_CI_COMMANDS: readonly string[] = Object.freeze(
    PLATFORM_NEUTRAL_CI_GATES.map(({ receiptCommand }) => receiptCommand),
);

export function platformCheckCommands(
    environment: NodeJS.ProcessEnv,
    options: PlatformCheckOptions = {},
): PlatformCheckCommand[] {
    const gates =
        options.includeVitest === false
            ? PLATFORM_NEUTRAL_CI_GATES.filter(({ id }) => id !== 'vitest')
            : PLATFORM_NEUTRAL_CI_GATES;
    const checks = gates.map((gate) => ({
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
