import { readFile } from 'node:fs/promises';

import type { CaxriMethod } from '@caxri/protocol';
import { capabilityIds, methods } from '@caxri/protocol';

import { CLI_COMMANDS, findCliCommand, parseCliArguments } from '../src/commands';

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/u).filter(Boolean);
}

/**
 * Collects inline code spans that name a command in prose. They carry placeholders such as `<id>`, so only their
 * command path can be resolved, not their arguments. A span qualifies when it starts with `caxri` or with a CLI root
 * followed by more words: a lone root such as `commander` is a capability name, while a bare group such as `agent
 * dispatch` must fail because it names no runnable command.
 */
function inlineCommandMentions(skill: string): string[][] {
    const roots = new Set<string>(CLI_COMMANDS.map((command) => command.path[0]));
    return skill
        .replaceAll(/^```[^\n]*\n[\s\S]*?\n```$/gmu, '')
        .matchAll(/`([^`\n]+)`/gu)
        .map((match) => tokenize(match[1]))
        .flatMap((tokens) => {
            if (tokens[0] === 'caxri') return tokens.length > 1 ? [tokens.slice(1)] : [];
            return roots.has(tokens[0]) && tokens.length > 1 ? [tokens] : [];
        })
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
