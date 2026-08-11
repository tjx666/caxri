import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';

import type { AgentProvider } from '../../../shared/agents';
import type {
    AgentHookBinding,
    AgentHookConfigEdit,
    AgentHookEntryStatus,
    DesiredHookInstall,
} from './contract';

const FORMATTING_OPTIONS: FormattingOptions = {
    eol: '\n',
    insertSpaces: true,
    tabSize: 2,
};
const HOOK_TIMEOUT_SECONDS = 1;

interface JsonHookHandler {
    command?: unknown;
    hooks?: unknown;
    type?: unknown;
}

interface JsonHookGroup {
    hooks?: unknown;
    matcher?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function parseDocument(source: string | undefined): Record<string, unknown> | undefined {
    if (source === undefined) return {};
    const errors: ParseError[] = [];
    const parsed: unknown = parse(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    if (errors.length > 0) return undefined;
    return record(parsed);
}

/**
 * Provider hook files are user-owned. Treat an unknown tree shape as malformed instead of
 * normalizing it, because replacing a scalar or array could destroy foreign configuration.
 */
function malformedHookTree(document: Record<string, unknown>): string | undefined {
    if (!Object.hasOwn(document, 'hooks')) return undefined;
    const hooks = record(document.hooks);
    if (!hooks) return 'The provider hooks value is not an object';
    for (const groupsValue of Object.values(hooks)) {
        if (!Array.isArray(groupsValue)) return 'A provider hook event is not an array';
        for (const groupValue of groupsValue) {
            const group = record(groupValue);
            if (!group || !Array.isArray(group.hooks))
                return 'A provider hook group does not contain a hooks array';
            if (!group.hooks.every((handler) => record(handler) !== undefined))
                return 'A provider hook handler is not an object';
        }
    }
    return undefined;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Creates a stable hook definition; ordinary bridge/app upgrades do not change Codex's trust hash. */
function buildBridgeCommand(
    desired: DesiredHookInstall,
    phase: AgentHookBinding['phase'],
    reply?: AgentHookBinding['reply'],
): string {
    return [
        shellQuote(desired.bridgePath),
        '--source caxri',
        `--provider ${desired.provider}`,
        `--phase ${phase}`,
        `--schema ${desired.schemaVersion}`,
        ...(reply ? [`--reply ${reply === 'emptyJson' ? 'empty-json' : reply}`] : []),
    ].join(' ');
}

function expectedGroup(desired: DesiredHookInstall, binding: AgentHookBinding): JsonHookGroup {
    return {
        hooks: [
            {
                type: 'command',
                command: buildBridgeCommand(desired, binding.phase, binding.reply),
                timeout: HOOK_TIMEOUT_SECONDS,
            },
        ],
    };
}

function ownedSchema(command: unknown, provider: AgentProvider): number | undefined {
    if (typeof command !== 'string') return undefined;
    const marker = `--source caxri --provider ${provider} --phase `;
    if (!command.includes(marker)) return undefined;
    const schema = command.match(/(?:^|\s)--schema\s+(\d+)(?:\s|$)/)?.[1];
    return schema ? Number(schema) : 0;
}

function ownedHandlers(group: unknown, provider: AgentProvider): JsonHookHandler[] {
    const hooks = record(group)?.hooks;
    if (!Array.isArray(hooks)) return [];
    return hooks.filter(
        (handler): handler is JsonHookHandler =>
            ownedSchema(record(handler)?.command, provider) !== undefined,
    );
}

function installedOwnedEntries(
    document: Record<string, unknown>,
    provider: AgentProvider,
): Array<{ event: string; group: JsonHookGroup; schema: number }> {
    const hooks = record(document.hooks);
    if (!hooks) return [];
    const installed: Array<{ event: string; group: JsonHookGroup; schema: number }> = [];
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue;
        for (const candidate of groups) {
            const group = record(candidate) as JsonHookGroup | undefined;
            if (!group) continue;
            for (const handler of ownedHandlers(group, provider)) {
                const schema = ownedSchema(handler.command, provider);
                if (schema !== undefined) installed.push({ event, group, schema });
            }
        }
    }
    return installed;
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function inspectJsonHooks(
    source: string | undefined,
    desired: DesiredHookInstall,
    bindings: readonly AgentHookBinding[],
): AgentHookEntryStatus {
    const document = parseDocument(source);
    if (!document)
        return { kind: 'unparseable', message: 'The provider hook configuration is not an object' };
    const malformed = malformedHookTree(document);
    if (malformed) return { kind: 'unparseable', message: malformed };
    const installed = installedOwnedEntries(document, desired.provider);
    if (installed.length === 0) return { kind: 'absent' };
    const schemas = installed.map((entry) => entry.schema);
    const newer = Math.max(...schemas);
    if (newer > desired.schemaVersion) return { kind: 'newer', installedSchema: newer };
    const older = Math.min(...schemas);
    if (older < desired.schemaVersion) return { kind: 'stale', installedSchema: older };
    if (installed.length !== bindings.length) return { kind: 'drifted' };
    for (const binding of bindings) {
        const matching = installed.filter((entry) => entry.event === binding.event);
        if (
            matching.length !== 1 ||
            !sameJson(matching[0]?.group, expectedGroup(desired, binding))
        ) {
            return { kind: 'drifted' };
        }
    }
    return { kind: 'current' };
}

function apply(source: string, path: Array<string | number>, value: unknown): string {
    return applyEdits(
        source,
        modify(source, path, value, { formattingOptions: FORMATTING_OPTIONS }),
    );
}

function withoutOwnedHandlers(source: string, provider: AgentProvider): string {
    const document = parseDocument(source);
    const hooks = record(document?.hooks);
    if (!hooks) return source;
    let next = source;
    for (const [event, groupsValue] of Object.entries(hooks)) {
        if (!Array.isArray(groupsValue)) continue;
        let remainingGroups = groupsValue.length;
        for (let groupIndex = groupsValue.length - 1; groupIndex >= 0; groupIndex -= 1) {
            const group = record(groupsValue[groupIndex]);
            const handlers = group?.hooks;
            if (!Array.isArray(handlers)) continue;
            const ownedIndexes = handlers.flatMap((handler, index) =>
                ownedSchema(record(handler)?.command, provider) === undefined ? [] : [index],
            );
            if (ownedIndexes.length === 0) continue;
            if (ownedIndexes.length === handlers.length) {
                next = apply(next, ['hooks', event, groupIndex], undefined);
                remainingGroups -= 1;
                continue;
            }
            for (const handlerIndex of ownedIndexes.toReversed())
                next = apply(next, ['hooks', event, groupIndex, 'hooks', handlerIndex], undefined);
        }
        if (remainingGroups === 0) next = apply(next, ['hooks', event], undefined);
    }
    const remainingDocument = parseDocument(next);
    const remainingHooks = record(remainingDocument?.hooks);
    if (remainingHooks && Object.keys(remainingHooks).length === 0)
        next = apply(next, ['hooks'], undefined);
    return next;
}

function withBindings(
    source: string,
    desired: DesiredHookInstall,
    bindings: readonly AgentHookBinding[],
): string {
    let next = source;
    let document = parseDocument(next) ?? {};
    if (!record(document.hooks)) {
        next = apply(next, ['hooks'], {});
        document = parseDocument(next) ?? {};
    }
    for (const binding of bindings) {
        const hooks = record(document.hooks) ?? {};
        const groups = hooks[binding.event];
        if (Array.isArray(groups))
            next = apply(
                next,
                ['hooks', binding.event, groups.length],
                expectedGroup(desired, binding),
            );
        else next = apply(next, ['hooks', binding.event], [expectedGroup(desired, binding)]);
        document = parseDocument(next) ?? {};
    }
    return next.endsWith('\n') ? next : `${next}\n`;
}

export function renderJsonHooks(
    targetId: string,
    source: string | undefined,
    desired: DesiredHookInstall,
    bindings: readonly AgentHookBinding[],
): AgentHookConfigEdit {
    const base = source ?? '{}\n';
    const document = parseDocument(base);
    const malformed = document ? malformedHookTree(document) : 'The provider config is invalid';
    if (malformed) throw new Error(malformed);
    return {
        targetId,
        source: withBindings(withoutOwnedHandlers(base, desired.provider), desired, bindings),
    };
}

export function removeJsonHooks(
    targetId: string,
    source: string | undefined,
    desired: DesiredHookInstall,
): AgentHookConfigEdit[] {
    if (source === undefined) return [];
    const document = parseDocument(source);
    if (!document || malformedHookTree(document)) return [];
    const installed = installedOwnedEntries(document, desired.provider);
    if (installed.length === 0 || installed.some((entry) => entry.schema > desired.schemaVersion)) {
        return [];
    }
    const next = withoutOwnedHandlers(source, desired.provider);
    return [{ targetId, source: next.endsWith('\n') ? next : `${next}\n` }];
}
