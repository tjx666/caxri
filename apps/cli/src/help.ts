import { CaxriError } from '@caxri/protocol';

import type { CliCommandDefinition } from './commands';
import { CLI_COMMANDS, CLI_GROUPS, describeCliCommand } from './commands';

/**
 * Introspection commands meant for scripts and Agents; the top-level help lists them after the everyday commands.
 */
const ADVANCED_COMMANDS = new Set(['capabilities', 'agent-context', 'request']);

const COMMON_TASKS: ReadonlyArray<{ command: string; summary: string }> = [
    { command: 'caxri open .', summary: 'Open the current folder in Caxri' },
    { command: 'caxri project list', summary: 'List your Projects' },
    { command: 'caxri session list', summary: 'List your Sessions' },
    { command: 'caxri skills get caxri-cli', summary: 'Print the guide your Agents read' },
];

const GLOBAL_OPTION_SUMMARIES: Record<string, string> = {
    '--json': 'Print one JSON value instead of readable text',
    '--quiet': 'Print only IDs, one per line',
    '--profile <absolute-path>': 'Use another Caxri data folder (default: the app profile)',
    '--request-id <id>': 'Make a change safe to retry',
    '--connect-timeout <milliseconds>': 'How long to wait for Caxri to respond',
    '--timeout <milliseconds>': 'How long a waiting command may run',
    '--yes': 'Skip the confirmation prompt',
    '--help': 'Show help',
    '--version': 'Show the CLI version',
};

export function topLevelHelp() {
    const everyday: Array<{ name: string; summary: string }> = [];
    const advanced: Array<{ name: string; summary: string }> = [];
    for (const command of CLI_COMMANDS) {
        if (command.path.length !== 1) continue;
        const entry = { name: command.path.join(' '), summary: command.summary };
        (ADVANCED_COMMANDS.has(entry.name) ? advanced : everyday).push(entry);
    }
    return {
        usage: 'caxri <command> [options]',
        commonTasks: COMMON_TASKS,
        commands: [...everyday, ...advanced],
        groups: CLI_GROUPS,
        options: Object.keys(GLOBAL_OPTION_SUMMARIES),
        optionSummaries: GLOBAL_OPTION_SUMMARIES,
    };
}

export function groupHelp(group: string) {
    const definition = CLI_GROUPS.find((candidate) => candidate.name === group);
    if (!definition) throw new CaxriError('VALIDATION', `Unknown command group: ${group}`);
    const commands: Array<{ name: string; summary: string; usage?: string }> = [];
    for (const command of CLI_COMMANDS) {
        if (command.path.length < 2 || command.path[0] !== group) continue;
        commands.push({
            name: command.path.slice(1).join(' '),
            summary: command.summary,
            ...('usage' in command && command.usage && { usage: command.usage }),
        });
    }
    return {
        usage: `caxri ${group} <command>`,
        summary: definition.summary,
        commands,
    };
}

export function commandHelp(command: CliCommandDefinition) {
    return {
        usage: `caxri ${command.path.join(' ')}${'usage' in command && command.usage ? ` ${command.usage}` : ''}`,
        ...describeCliCommand(command),
    };
}

export function renderHelp(
    value:
        | ReturnType<typeof topLevelHelp>
        | ReturnType<typeof groupHelp>
        | ReturnType<typeof commandHelp>,
): string {
    const lines = [`Usage: ${value.usage}`];
    if ('summary' in value && value.summary) lines.push('', value.summary);
    if ('commonTasks' in value) {
        lines.push('', 'Common tasks:');
        for (const task of value.commonTasks)
            lines.push(`  ${task.command.padEnd(30)} ${task.summary}`);
    }
    if ('groups' in value) {
        lines.push('', 'Groups:');
        for (const group of value.groups) lines.push(`  ${group.name.padEnd(12)} ${group.summary}`);
    }
    if ('commands' in value && value.commands.length > 0) {
        lines.push('', 'Commands:');
        for (const command of value.commands)
            lines.push(
                `  ${`${command.name}${'usage' in command && command.usage ? ` ${command.usage}` : ''}`.padEnd(24)} ${command.summary}`,
            );
    }
    if ('options' in value) {
        lines.push('', 'Global options:');
        const summaries: Record<string, string> =
            'optionSummaries' in value ? value.optionSummaries : {};
        for (const option of value.options)
            lines.push(
                summaries[option] ? `  ${option.padEnd(34)} ${summaries[option]}` : `  ${option}`,
            );
    }
    if ('method' in value && value.method) {
        lines.push(
            '',
            `Method: ${value.method}`,
            `Effect: ${value.effect}`,
            `Capabilities: ${value.capabilities?.join(', ') ?? ''}`,
        );
    }
    return `${lines.join('\n')}\n`;
}
