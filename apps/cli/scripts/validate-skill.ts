import { readFile } from 'node:fs/promises';

import type { CaxriMethod } from '@caxri/protocol';
import { capabilityIds, methods } from '@caxri/protocol';

import { CLI_COMMANDS, findCliCommand, parseCliArguments } from '../src/commands';

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/u).filter(Boolean);
}

/**
 * Resolves the command path of an inline mention the way the CLI does, dropping global options such as `--json`
 * wherever they appear. A placeholder value (`--timeout <milliseconds>`) fails that option's own validation; the raw
 * words still resolve because command lookup matches by prefix.
 */
function mentionedCommandPath(words: readonly string[]): string[] {
    try {
        return parseCliArguments(words).tokens;
    } catch {
        return [...words];
    }
}

/**
 * Collects inline code spans that name a command in prose. They carry placeholders such as `<id>`, so only their
 * command path can be resolved, not their arguments. A span qualifies when it starts with `caxri`, or when it starts
 * with any command path word and has more words: a bare group such as `agent dispatch` or a shorthand such as `stop
 * <id>` must fail because neither names a runnable command. A lone word is indistinguishable from a capability or field
 * name (`commander`, `status`), so a one-word command is written with the `caxri` prefix. Markdown lets an inline span
 * wrap across lines, so a span may contain newlines.
 */
function inlineCommandMentions(skill: string): string[][] {
    const commandWords = new Set<string>(CLI_COMMANDS.flatMap((command) => command.path));
    return skill
        .replaceAll(/^```[^\n]*\n[\s\S]*?\n```$/gmu, '')
        .matchAll(/`([^`]+)`/gu)
        .map((match) => tokenize(match[1]))
        .flatMap((words) => {
            if (words[0] === 'caxri') return [mentionedCommandPath(words.slice(1))];
            return commandWords.has(words[0]) && words.length > 1
                ? [mentionedCommandPath(words)]
                : [];
        })
        .filter((path) => path.length > 0)
        .toArray();
}

export function validateSkillCommands(skill: string): {
    capabilityCount: number;
    commandCount: number;
    mentionCount: number;
} {
    const commandLines = skill
        .matchAll(/^caxri (.+)$/gmu)
        .map((match) => match[1])
        .toArray();
    if (commandLines.length === 0) throw new Error('caxri-cli skill has no command examples');

    for (const source of commandLines) {
        const parsed = parseCliArguments(tokenize(source));
        const command = findCliCommand(parsed.tokens);
        if (!command) throw new Error(`Skill references an unknown command: caxri ${source}`);
        const parameters = command.parseParams(parsed.tokens.slice(command.path.length));
        if (command.kind === 'remote') {
            let requestParameters = parameters;
            if (command.method === 'agent.message.wait')
                requestParameters = { timeoutMs: parsed.timeoutMs };
            else if (command.method === 'agent.dispatch.wait')
                requestParameters = { ...(parameters as object), timeoutMs: parsed.timeoutMs };
            methods[command.method].params.parse(requestParameters);
        }
    }

    const mentions = inlineCommandMentions(skill);
    for (const tokens of mentions) {
        if (!findCliCommand(tokens))
            throw new Error(`Skill mentions an unknown command: \`${tokens.join(' ')}\``);
    }

    const capabilityMarker = skill.match(/<!-- caxri-capabilities: ([^>]+) -->/u)?.[1];
    if (!capabilityMarker)
        throw new Error('caxri-cli skill is missing its capability validation marker');
    const capabilities = capabilityMarker.split(',');
    const knownCapabilities = new Set<string>(capabilityIds);
    for (const capability of capabilities) {
        if (!knownCapabilities.has(capability))
            throw new Error(`Skill references an unknown capability: ${capability}`);
    }

    const describedMethods = new Set<CaxriMethod>();
    for (const command of commandLines) {
        const parsed = parseCliArguments(tokenize(command));
        const definition = findCliCommand(parsed.tokens);
        if (definition?.kind === 'remote') describedMethods.add(definition.method);
    }
    if (!describedMethods.has('settings.patch') || !describedMethods.has('agent.message.wait'))
        throw new Error('caxri-cli skill must retain Settings dry-run and Peer pull workflows');

    return {
        capabilityCount: capabilities.length,
        commandCount: commandLines.length,
        mentionCount: mentions.length,
    };
}

async function validateSkillFile(): Promise<void> {
    const skill = await readFile(
        new URL('../../../skills/caxri-cli/SKILL.md', import.meta.url),
        'utf8',
    );
    const result = validateSkillCommands(skill);
    console.log(
        `Validated caxri-cli skill (${result.commandCount} commands, ${result.mentionCount} mentions, ${result.capabilityCount} capabilities)`,
    );
}

if (import.meta.main) await validateSkillFile();
