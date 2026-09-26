import type { AgentProvider } from '@caxri/protocol';
import type { FormattingOptions, ParseError } from 'jsonc-parser';
import { applyEdits, modify, parse } from 'jsonc-parser';

import { AGENT_HOOK_BRIDGE_MAX_DELIVERY_MS } from './bridge';
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
/**
 * The provider deadline includes shell and Electron-as-Node startup in addition to the bridge's stdin and socket
 * budgets. The socket budget also covers the bounded PreToolUse topology capture. Keep explicit startup headroom so a
 * cold bridge is not killed before it can identify a resumed session.
 */
const HOOK_STARTUP_HEADROOM_MS = 2_000;
const HOOK_TIMEOUT_SECONDS = Math.ceil(
    (AGENT_HOOK_BRIDGE_MAX_DELIVERY_MS + HOOK_STARTUP_HEADROOM_MS) / 1_000,
);

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
 * Provider hook files are user-owned. Treat an unknown tree shape as malformed instead of normalizing it, because
 * replacing a scalar or array could destroy foreign configuration.
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
            if (group.hooks.some((handler) => record(handler) === undefined))
                return 'A provider hook handler is not an object';
        }
    }
    return undefined;
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Creates a stable hook definition; ordinary bridge/app upgrades do not change Codex's trust hash.
 *
 * `--schema N` is a file-convergence marker only. Every Caxri build on the machine (a packaged release and a dev
 * instance, for example) writes the same global provider file, so the managers need one token that says which build's
 * entries win: a build repairs entries older than its own and leaves newer ones alone (issue #557). The bridge never
 * reads this flag. The schema version a running instance actually expects, and the socket it listens on, travel in that
 * instance's `CAXRI_HOOK_*` Terminal launch environment, so a build whose entries were superseded still receives and
 * accepts its own signals.
 */
function buildBridgeCommand(
    desired: DesiredHookInstall,
    phase: AgentHookBinding['phase'],
    reply?: AgentHookBinding['reply'],
    interactive?: AgentHookBinding['interactive'],
): string {
    return [
        shellQuote(desired.bridgePath),
        '--source caxri',
        `--provider ${desired.provider}`,
        `--phase ${phase}`,
        `--schema ${desired.schemaVersion}`,
        // `AgentHookBinding['reply']` currently has one literal (`'emptyJson'`); this maps it to the
        // bridge CLI's kebab-case flag value. Revisit this mapping if that union ever grows.
        ...(reply === 'emptyJson' ? ['--reply empty-json'] : []),
        ...(interactive ? [`--interactive ${interactive}`] : []),
    ].join(' ');
}

function expectedGroup(desired: DesiredHookInstall, binding: AgentHookBinding): JsonHookGroup {
    return {
        ...(binding.matcher && { matcher: binding.matcher }),
        hooks: [
            {
                type: 'command',
                command: buildBridgeCommand(
                    desired,
                    binding.phase,
                    binding.reply,
                    binding.interactive,
                ),
                timeout: binding.interactive ? 130 : HOOK_TIMEOUT_SECONDS,
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

function installedOwnedEntriesForEvent(
    event: string,
    groups: unknown[],
    provider: AgentProvider,
): Array<{ event: string; group: JsonHookGroup; schema: number }> {
    const installed: Array<{ event: string; group: JsonHookGroup; schema: number }> = [];
    for (const candidate of groups) {
        const group = record(candidate) as JsonHookGroup | undefined;
        if (!group) continue;
        for (const handler of ownedHandlers(group, provider)) {
            const schema = ownedSchema(handler.command, provider);
            if (schema !== undefined) installed.push({ event, group, schema });
        }
    }
    return installed;
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
        installed.push(...installedOwnedEntriesForEvent(event, groups, provider));
    }
    return installed;
}

function isSameJson(left: unknown, right: unknown): boolean {
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
    if (schemas.some((schema) => !Number.isSafeInteger(schema)))
        return { kind: 'unparseable', message: 'Installed hook schema is not a safe integer' };
    const newer = Math.max(...schemas);
    if (newer > desired.schemaVersion) {
        /**
         * Newer builds may add fields and events, but must still cover this build's required lifecycle bindings.
         */
        const complete = bindings.every((binding) =>
            installed.some(
                (entry) =>
                    entry.event === binding.event &&
                    entry.group.matcher === binding.matcher &&
                    ownedHandlers(entry.group, desired.provider).some((handler) => {
                        const command = handler.command;
                        return (
                            handler.type === 'command' &&
                            typeof command === 'string' &&
                            new RegExp(
                                String.raw`(?:^|\s)--phase\s+${binding.phase}(?:\s|$)`,
                                'u',
                            ).test(command) &&
                            (binding.reply !== 'emptyJson' ||
                                /(?:^|\s)--reply\s+empty-json(?:\s|$)/u.test(command))
                        );
                    }),
            ),
        );
        return { kind: complete ? 'newer' : 'newerIncomplete', installedSchema: newer };
    }
    const older = Math.min(...schemas);
    if (older < desired.schemaVersion) return { kind: 'stale', installedSchema: older };
    if (installed.length !== bindings.length) return { kind: 'drifted' };
    for (const binding of bindings) {
        const matching = installed.filter(
            (entry) =>
                entry.event === binding.event &&
                isSameJson(entry.group, expectedGroup(desired, binding)),
        );
        if (matching.length !== 1) {
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

function withoutOwnedHandlersForEvent(
    source: string,
    event: string,
    groupsValue: unknown[],
    provider: AgentProvider,
): string {
    let next = source;
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
    return next;
}

function withoutOwnedHandlers(source: string, provider: AgentProvider): string {
    const document = parseDocument(source);
    const hooks = record(document?.hooks);
    if (!hooks) return source;
    let next = source;
    for (const [event, groupsValue] of Object.entries(hooks)) {
        if (!Array.isArray(groupsValue)) continue;
        next = withoutOwnedHandlersForEvent(next, event, groupsValue, provider);
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

/**
 * Codex keys trust by event/group/handler position. Routine upgrades must replace existing standalone groups in place
 * so repairing Caxri cannot invalidate neighboring user hooks. Malformed legacy duplicates still use normalization.
 * https://github.com/openai/codex/tree/main/codex-rs/hooks
 */
function replaceBindingsInPlace(
    source: string,
    document: Record<string, unknown>,
    desired: DesiredHookInstall,
    bindings: readonly AgentHookBinding[],
): string | undefined {
    const hooks = record(document.hooks);
    if (!hooks) return;
    const installed = installedOwnedEntries(document, desired.provider);
    if (
        installed.some(
            (entry) =>
                bindings.every((binding) => binding.event !== entry.event) ||
                installed.filter((candidate) => candidate.event === entry.event).length !== 1 ||
                !Array.isArray(entry.group.hooks) ||
                entry.group.hooks.length !== 1,
        )
    )
        return;
    let next = source;
    const missing: AgentHookBinding[] = [];
    for (const binding of bindings) {
        const groups = hooks[binding.event];
        const index = Array.isArray(groups)
            ? groups.findIndex((group) => ownedHandlers(group, desired.provider).length > 0)
            : -1;
        if (index === -1) missing.push(binding);
        else next = apply(next, ['hooks', binding.event, index], expectedGroup(desired, binding));
    }
    return withBindings(next, desired, missing);
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
        source:
            replaceBindingsInPlace(base, document!, desired, bindings) ??
            withBindings(withoutOwnedHandlers(base, desired.provider), desired, bindings),
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
