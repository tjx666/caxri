const COMMAND_USAGE = {
    'finalize': `finalize --dir DIR --requirement TEXT [--conclusion TEXT]
       Requires a replaced proposal.md and a reviewer-facing description on every artifact`,
    'init': `init --dir DIR --plan PLAN_JSON --title TEXT --entry TEXT --requirement TEXT
       [--branch NAME] [--commit SHA] [--pull-request N]
       Creates result.json, report.md, a proposal.md placeholder, and assets/`,
    'rebind-head': `rebind-head --dir DIR --from-commit SHA --commit SHA --entry TEXT --reason TEXT [--allow-finalized]
       [--created-at ISO_TIMESTAMP]`,
    'repair-lifecycle': `repair-lifecycle --dir DIR --case-id ID --reason TEXT
       Completes a launch the launcher never finished; isolated profiles must already be gone`,
} as const;

const COMMAND_ORDER = ['init', 'rebind-head', 'repair-lifecycle', 'finalize'] as const;

export type ReportCommand = keyof typeof COMMAND_USAGE;
export type ReportOptions = Record<string, string | true>;

export function isReportCommand(command: string): command is ReportCommand {
    return Object.hasOwn(COMMAND_USAGE, command);
}

export function reportCliHelp(): string {
    const commands = COMMAND_ORDER.map((command) => `  ${COMMAND_USAGE[command]}`).join('\n');
    return `Caxri Acceptance report scaffold

Commands:
${commands}`;
}

/**
 * Appends the command's own usage to an argument error, so a mistyped call such as `finalize <round-dir>` names the
 * `--dir` and `--requirement` options it needs instead of leaving the caller to guess or rerun with `--help`.
 */
function usageError(command: ReportCommand, message: string): Error {
    return new Error(`${message}\nUsage: ${COMMAND_USAGE[command]}`);
}

export function parseReportOptions(command: ReportCommand, tokens: string[]): ReportOptions {
    const options: ReportOptions = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token.startsWith('--')) {
            throw usageError(command, `Expected an option, received: ${token}`);
        }
        const key = token.slice(2);
        const next = tokens[index + 1];
        options[key] = next && !next.startsWith('--') ? tokens[++index] : true;
    }
    return options;
}

export function reportOption(
    command: ReportCommand,
    options: ReportOptions,
    key: string,
    isRequired = false,
): string | undefined {
    const value = options[key];
    if (isRequired && (typeof value !== 'string' || value.length === 0)) {
        throw usageError(command, `Missing --${key}`);
    }
    return typeof value === 'string' ? value : undefined;
}
