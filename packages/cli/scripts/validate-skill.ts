import { readFile } from 'node:fs/promises';

import { capabilityIds, methods, type CaxriMethod } from '@caxri/protocol';

import { parseCliArguments } from '../src/arguments';
import { findCliCommand } from '../src/command-catalog';

const skill = await readFile(
    new URL('../../../skills/caxri-cli/SKILL.md', import.meta.url),
    'utf8',
);

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/u).filter(Boolean);
}

const commandLines = [...skill.matchAll(/^caxri (.+)$/gmu)].map((match) => match[1]);
if (commandLines.length === 0) throw new Error('caxri-cli skill has no command examples');

for (const source of commandLines) {
    const parsed = parseCliArguments(tokenize(source));
    const command = findCliCommand(parsed.tokens);
    if (!command) throw new Error(`Skill references an unknown command: caxri ${source}`);
    const params = command.parseParams(parsed.tokens.slice(command.path.length));
    if (command.kind === 'remote') {
        let requestParams = params;
        if (command.method === 'agent.message.wait')
            requestParams = { timeoutMs: parsed.timeoutMs };
        if (command.method === 'agent.dispatch.wait')
            requestParams = { ...(params as object), timeoutMs: parsed.timeoutMs };
        methods[command.method].params.parse(requestParams);
    }
}

const capabilityMarker = skill.match(/<!-- caxri-capabilities: ([^>]+) -->/u)?.[1];
if (!capabilityMarker)
    throw new Error('caxri-cli skill is missing its capability validation marker');
const knownCapabilities = new Set<string>(capabilityIds);
for (const capability of capabilityMarker.split(',')) {
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

console.log(
    `Validated caxri-cli skill (${commandLines.length} commands, ${capabilityMarker.split(',').length} capabilities)`,
);
