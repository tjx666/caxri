import { readFile } from 'node:fs/promises';

import type { CaxriMethod } from '@caxri/protocol';
import { capabilityIds, methods } from '@caxri/protocol';

import { findCliCommand, parseCliArguments } from '../src/commands';

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/u).filter(Boolean);
}

export function validateSkillCommands(skill: string): {
    capabilityCount: number;
    commandCount: number;
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

    return { capabilityCount: capabilities.length, commandCount: commandLines.length };
}

async function validateSkillFile(): Promise<void> {
    const skill = await readFile(
        new URL('../../../skills/caxri-cli/SKILL.md', import.meta.url),
        'utf8',
    );
    const result = validateSkillCommands(skill);
    console.log(
        `Validated caxri-cli skill (${result.commandCount} commands, ${result.capabilityCount} capabilities)`,
    );
}

if (import.meta.main) await validateSkillFile();
