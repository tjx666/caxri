import { readFile } from 'node:fs/promises';

import type { CaxriMethod } from '@caxri/protocol';
import { capabilityIds, methods } from '@caxri/protocol';

import { CLI_COMMANDS, findCliCommand, parseCliArguments } from '../src/commands';

function tokenize(command: string): string[] {
    return command.trim().split(/\s+/u).filter(Boolean);
}

/**
 * Resolves the command path of an inline mention the way the CLI does, dropping global options such as `--json`
 * wherever they appear. An option's placeholder value (`--timeout <milliseconds>`) is replaced with a valid sample
 * first, so that option's own validation does not reject the documentation form. Returns undefined when the words are
 * not a parseable invocation, such as a lone `--request-id`.
 */
function mentionedCommandPath(words: readonly string[]): string[] | undefined {
    const sampled = words.map((word, index) =>
        index > 0 && words[index - 1].startsWith('-') && /^<.+>$/u.test(word) ? '1000' : word,
    );
    try {
        return parseCliArguments(sampled).tokens;
    } catch {
        return undefined;
    }
}

interface CommandMention {
    path: string[];
    source: string;
}

/**
 * Collects inline code spans that name a command in prose. They carry placeholders such as `<id>`, so only their
 * command path can be resolved, not their arguments. A `caxri`-prefixed span always qualifies. Any other span qualifies
 * when its command path starts with a command word followed by another command word, a `<placeholder>`, or an option,
 * so a bare group (`agent dispatch`) and a shorthand (`stop <id>`) fail because neither names a runnable command, while
 * field prose such as `message = null` is skipped. A lone word is indistinguishable from a capability or field name
 * (`commander`, `status`), so a one-word command is written with the `caxri` prefix. Markdown lets an inline span wrap
 * across lines, so a span may contain newlines.
 */
function inlineCommandMentions(skill: string): CommandMention[] {
    const commandWords = new Set<string>(CLI_COMMANDS.flatMap((command) => command.path));
    return skill
        .replaceAll(/^```[^\n]*\n[\s\S]*?\n```$/gmu, '')
        .matchAll(/`([^`]+)`/gu)
        .map((match) => tokenize(match[1]))
        .flatMap((words): CommandMention[] => {
            const source = words.join(' ');
            if (words[0] === 'caxri') {
                const path = mentionedCommandPath(words.slice(1)) ?? words.slice(1);
                return path.length > 0 ? [{ path, source }] : [];
            }
            const path = mentionedCommandPath(words);
            const isCommand =
                path !== undefined &&
                path.length > 1 &&
                commandWords.has(path[0]) &&
                (commandWords.has(path[1]) || /^[<-]/u.test(path[1]));
            return isCommand ? [{ path, source }] : [];
        })
        .toArray();
}

export async function validateSkillCommands(skill: string): Promise<{
    capabilityCount: number;
    commandCount: number;
    mentionCount: number;
}> {
    const commandLines = skill
        .matchAll(/^caxri (.+)$/gmu)
        .map((match) => match[1])
        .toArray();
    if (commandLines.length === 0) throw new Error('caxri-cli skill has no command examples');

    for (const source of commandLines) {
        const parsed = parseCliArguments(tokenize(source));
        const command = findCliCommand(parsed.tokens);
        if (!command) throw new Error(`Skill references an unknown command: caxri ${source}`);
        // eslint-disable-next-line no-await-in-loop -- examples are validated in order, so the first bad one is reported
        const parameters = await command.parseParams(parsed.tokens.slice(command.path.length));
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
    for (const { path, source } of mentions) {
        if (!findCliCommand(path))
            throw new Error(`Skill mentions an unknown command: \`${source}\``);
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
    const result = await validateSkillCommands(skill);
    console.log(
        `Validated caxri-cli skill (${result.commandCount} commands, ${result.mentionCount} mentions, ${result.capabilityCount} capabilities)`,
    );
}

if (import.meta.main) await validateSkillFile();
