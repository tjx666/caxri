import type { ParseError } from 'jsonc-parser';
import { applyEdits, modify, parse } from 'jsonc-parser';

import type {
    AgentHookAdapter,
    AgentHookBinding,
    AgentHookEntryStatus,
    DesiredHookInstall,
} from '../../hooks/contract';
import {
    buildBridgeCommand,
    HOOK_TIMEOUT_SECONDS,
    ownedSchema,
    shellQuote,
} from '../../hooks/json-config';
import { antigravityHooksPath } from './paths';

/**
 * Antigravity's lifecycle events, verified against `agy` 1.4.11. `PreInvocation` runs before every model call; the
 * bridge forwards only a turn's first (`invocationNum` 0). Identity comes from the `conversationId` these events carry:
 * `SessionStart` is not bound because a subagent's conversation fires it too, with nothing that tells it apart from the
 * main one. Every handler must print a JSON object.
 */
const bindings = [
    { event: 'PreInvocation', phase: 'turnStarted', reply: 'emptyJson' },
    { event: 'Stop', phase: 'turnFinished', reply: 'emptyJson' },
] as const satisfies readonly AgentHookBinding[];

/**
 * The named hook Caxri owns in `hooks.json`, whose top-level keys name independent hooks. Every handler under it is
 * Caxri's, so repairing it never touches another tool's hooks.
 */
const HOOK_NAME = 'caxri';
const target = 'hooks';

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Json)
        : undefined;
}

function parseDocument(source: string | undefined): Json | undefined {
    if (source === undefined) return {};
    const errors: ParseError[] = [];
    const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
    return errors.length > 0 ? undefined : record(parsed);
}

/**
 * `agy acp` splits a hook command into argv instead of running it through a shell, so the command is a shell invocation
 * that works both ways.
 */
function handler(desired: DesiredHookInstall, binding: AgentHookBinding): Json {
    return {
        type: 'command',
        command: `/bin/sh -c ${shellQuote(buildBridgeCommand(desired, binding.phase, binding.reply))}`,
        timeout: HOOK_TIMEOUT_SECONDS,
    };
}

function expectedEntry(desired: DesiredHookInstall): Json {
    return Object.fromEntries(
        bindings.map((binding) => [binding.event, [handler(desired, binding)]]),
    );
}

function installedCommands(entry: Json): Array<{ event: string; command: string }> {
    return Object.entries(entry).flatMap(([event, handlers]) =>
        Array.isArray(handlers)
            ? handlers.flatMap((value) => {
                  const command = record(value)?.command;
                  return typeof command === 'string' ? [{ event, command }] : [];
              })
            : [],
    );
}

function inspect(source: string | undefined, desired: DesiredHookInstall): AgentHookEntryStatus {
    const document = parseDocument(source);
    if (!document)
        return { kind: 'unparseable', message: 'The provider hook configuration is not an object' };
    if (!Object.hasOwn(document, HOOK_NAME)) return { kind: 'absent' };
    const entry = record(document[HOOK_NAME]);
    if (!entry) return { kind: 'unparseable', message: 'The Caxri hook entry is not an object' };
    const commands = installedCommands(entry);
    const schemas = commands.flatMap(({ command }) => ownedSchema(command, desired.provider) ?? []);
    if (schemas.length === 0) return { kind: 'drifted' };
    if (schemas.some((schema) => !Number.isSafeInteger(schema)))
        return { kind: 'unparseable', message: 'Installed hook schema is not a safe integer' };
    const newer = Math.max(...schemas);
    if (newer > desired.schemaVersion) {
        const isComplete = bindings.every((binding) =>
            commands.some(
                ({ event, command }) =>
                    event === binding.event && command.includes(`--phase ${binding.phase} `),
            ),
        );
        return { kind: isComplete ? 'newer' : 'newerIncomplete', installedSchema: newer };
    }
    const older = Math.min(...schemas);
    if (older < desired.schemaVersion) return { kind: 'stale', installedSchema: older };
    return JSON.stringify(entry) === JSON.stringify(expectedEntry(desired))
        ? { kind: 'current' }
        : { kind: 'drifted' };
}

function edit(source: string, value: unknown): string {
    const next = applyEdits(
        source,
        modify(source, [HOOK_NAME], value, {
            formattingOptions: { eol: '\n', insertSpaces: true, tabSize: 2 },
        }),
    );
    return next.endsWith('\n') ? next : `${next}\n`;
}

export const antigravityHookAdapter: AgentHookAdapter = {
    bindings,
    schemaVersion: 1,
    configTargets: (environment) => [
        { id: target, path: antigravityHooksPath(environment), writable: true },
    ],
    inspect: (documents, desired) => ({ status: inspect(documents.get(target), desired) }),
    remove: (documents, desired) => {
        const source = documents.get(target);
        const status = inspect(source, desired);
        if (source === undefined || !['current', 'stale', 'drifted'].includes(status.kind))
            return [];
        return [{ targetId: target, source: edit(source, undefined) }];
    },
    render: (documents, desired) => {
        const source = documents.get(target) ?? '{}\n';
        if (!parseDocument(source)) throw new Error('The provider hook configuration is invalid');
        return [{ targetId: target, source: edit(source, expectedEntry(desired)) }];
    },
    supports: () => ({
        supported: true,
        // The bridge reports a Stop that ended on an error or a cancel as a failed turn.
        phases: [...bindings.map((binding) => binding.phase), 'turnFailed'],
    }),
};
