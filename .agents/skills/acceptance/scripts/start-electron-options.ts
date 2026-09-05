/**
 * Command-line option parsing for the macOS Acceptance launcher, kept beside the launcher so its lifecycle logic stays
 * within the file budget.
 */
type OptionValue = string | true;
// Partial (not Record<string, OptionValue[]>): the object starts empty and keys are only
// populated for flags actually present on argv, so an arbitrary key genuinely may be absent.
type ParsedOptions = Partial<Record<string, OptionValue[]>>;

export function parseOptions(argv: string[]): ParsedOptions {
    const options: ParsedOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`Expected an option, received: ${token}`);
        const key = token.slice(2);
        const next = argv[index + 1];
        (options[key] ??= []).push(next && !next.startsWith('--') ? argv[++index] : true);
    }
    return options;
}

export function stringOptions(options: ParsedOptions, key: string): string[] {
    const values = options[key] ?? [];
    if (values.includes(true)) throw new Error(`--${key} requires a value`);
    return values as string[];
}

export function stringOption(options: ParsedOptions, key: string): string | undefined {
    const values = options[key] ?? [];
    if (values.length > 1) throw new Error(`--${key} may only be provided once`);
    const value = values[0];
    if (value === true) throw new Error(`--${key} requires a value`);
    return value;
}

export function hasBooleanOption(options: ParsedOptions, key: string): boolean {
    const values = options[key] ?? [];
    if (values.length > 1) throw new Error(`--${key} may only be provided once`);
    if (values.some((value) => value !== true)) throw new Error(`--${key} does not take a value`);
    return values.length === 1;
}

export function help(): string {
    return `Start an isolated Caxri Electron acceptance instance

Options:
  --port N               CDP port (default: 9222)
  --test-root PATH       Project root selected in Caxri; repeat to queue roots (default: repository root)
  --agent-fixture ID     Plan-declared, repository-owned fake Agent fixture
  --native-dialog        Explicit-current-request exception: use the real macOS picker
  --case-id ID           Stable ASCII id for this isolated Acceptance case
  --report-dir DIR       Frozen round containing this case plan and lifecycle evidence
  --case-mode MODE       isolated (default) or restart
  --reuse-user-data PATH Reuse this case's frozen caxri-acceptance-user-<profile-id>-* profile
  --cleanup-reused-user-data
                         Remove the validated reusable profile when this launch stops
  --help                 Show this message`;
}
