import { resolve } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds, CaxriError, sessionSearchStatusFilters } from '@caxri/protocol';

import { rejectOptions } from './reject-options';
import type { RemoteCommandDefinition } from './types';

/**
 * A relative path names a folder from the caller's working directory, as an Agent sees it; Server Core only accepts an
 * absolute one.
 */
function projectAddParameters(tokens: readonly string[]): { path: string } {
    const [path, ...rest] = tokens;
    if (!path || path.startsWith('--'))
        throw new CaxriError('VALIDATION', 'project add requires exactly one folder path');
    rejectOptions(rest);
    return { path: resolve(path) };
}

function selectorQuery(
    tokens: readonly string[],
    mode: 'list' | 'show',
    scope?: { flag: string; key: 'projectId' | 'sessionId' },
): Record<string, unknown> {
    const positional: string[] = [];
    let scopeValue: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === scope?.flag) {
            const value = tokens[index + 1];
            if (!value || value.startsWith('--'))
                throw new CaxriError('VALIDATION', `${scope.flag} requires a value`);
            if (scopeValue)
                throw new CaxriError('VALIDATION', `${scope.flag} may be provided only once`);
            scopeValue = value;
            index += 1;
        } else if (token.startsWith('--')) {
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        } else positional.push(token);
    }
    if (mode === 'list' && positional.length > 0)
        throw new CaxriError('VALIDATION', `Unexpected argument: ${positional[0]}`);
    if (mode === 'show' && positional.length !== 1)
        throw new CaxriError('VALIDATION', 'show requires exactly one ID or name');
    return {
        mode,
        ...(mode === 'show' && { selector: positional[0] }),
        ...(scope && scopeValue && { [scope.key]: scopeValue }),
    };
}

function optionValue(tokens: readonly string[], index: number, flag: string): string {
    const value = tokens.at(index + 1);
    if (value === undefined || value.startsWith('--'))
        throw new CaxriError('VALIDATION', `${flag} requires a value`);
    return value;
}

function rejectFlags(tokens: readonly string[]): void {
    const flag = tokens.find((token) => token.startsWith('--'));
    if (flag) throw new CaxriError('VALIDATION', `Unknown option: ${flag.split('=', 1)[0]}`);
}

function oneOf<Value extends string>(
    value: string,
    allowed: readonly Value[],
    flag: string,
): Value {
    if (!(allowed as readonly string[]).includes(value))
        throw new CaxriError('VALIDATION', `${flag} must be one of: ${allowed.join(', ')}`);
    return value as Value;
}

/**
 * Every positional token joins the query, so `caxri session search fix login` needs no quoting.
 */
function sessionSearchParameters(tokens: readonly string[]): Record<string, unknown> {
    const terms: string[] = [];
    const providers: AgentProvider[] = [];
    let status: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--provider') {
            providers.push(oneOf(optionValue(tokens, index, token), agentProviderIds, token));
            index += 1;
        } else if (token === '--status') {
            if (status) throw new CaxriError('VALIDATION', '--status may be provided only once');
            status = oneOf(optionValue(tokens, index, token), sessionSearchStatusFilters, token);
            index += 1;
        } else if (token.startsWith('--')) {
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        } else terms.push(token);
    }
    return {
        query: terms.join(' '),
        ...(providers.length > 0 && { providers }),
        ...(status && { status }),
    };
}

/**
 * Takes a search result's `key` (`<provider>:<conversation id>`) as printed by `session search --quiet`, or the
 * provider and conversation ID as two arguments.
 */
function sessionImportParameters(tokens: readonly string[]): {
    agentSessionId: string;
    provider: AgentProvider;
} {
    rejectFlags(tokens);
    const [first, second, ...rest] = tokens as ReadonlyArray<string | undefined>;
    if (!first || rest.length > 0)
        throw new CaxriError(
            'VALIDATION',
            'session import requires <provider>:<conversation-id> or <provider> <conversation-id>',
        );
    const separator = first.indexOf(':');
    const [provider, agentSessionId] =
        second === undefined && separator > 0
            ? [first.slice(0, separator), first.slice(separator + 1)]
            : [first, second];
    if (!agentSessionId)
        throw new CaxriError(
            'VALIDATION',
            'session import requires <provider>:<conversation-id> or <provider> <conversation-id>',
        );
    return { provider: oneOf(provider, agentProviderIds, 'provider'), agentSessionId };
}

function sessionRenameParameters(tokens: readonly string[]): { sessionId: string; title: string } {
    let sessionId: string | undefined;
    let title: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--title' && title === undefined) {
            title = tokens.at(index + 1);
            if (title === undefined) throw new CaxriError('VALIDATION', '--title requires a value');
            index += 1;
        } else if (sessionId === undefined && !token.startsWith('--')) sessionId = token;
        else throw new CaxriError('VALIDATION', `Unexpected argument: ${token.split('=', 1)[0]}`);
    }
    if (!sessionId || title === undefined)
        throw new CaxriError('VALIDATION', 'session rename requires <session-id> --title <text>');
    return { sessionId, title };
}

function sessionPinParameters(isPinned: boolean) {
    return (tokens: readonly string[]): { pinned: boolean; sessionId: string } => {
        rejectFlags(tokens);
        if (tokens.length !== 1)
            throw new CaxriError(
                'VALIDATION',
                `session ${isPinned ? 'pin' : 'unpin'} requires one <session-id>`,
            );
        return { sessionId: tokens[0], pinned: isPinned };
    };
}

/**
 * Project, Session, and Terminal record queries, adding a folder as a Project, and finding, importing, renaming, and
 * pinning Sessions.
 */
export const RECORD_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['project', 'list'],
        method: 'project.query',
        summary: 'List Projects visible to the authenticated principal.',
        parseParams: (tokens) => selectorQuery(tokens, 'list'),
        quietKey: 'projects',
    },
    {
        kind: 'remote',
        path: ['project', 'show'],
        method: 'project.query',
        summary: 'Show one exact Project by opaque ID or unambiguous name.',
        usage: '<id-or-name>',
        parseParams: (tokens) => selectorQuery(tokens, 'show'),
        quietKey: 'projects',
    },
    {
        kind: 'remote',
        path: ['project', 'current'],
        method: 'project.query',
        summary: 'Show the current Project for this profile.',
        parseParams: (tokens) => ({ ...rejectOptions(tokens), mode: 'current' }),
        quietKey: 'projects',
    },
    {
        kind: 'remote',
        path: ['project', 'add'],
        method: 'project.add',
        summary: 'Add an existing folder as a Project, or return the Project that already owns it.',
        usage: '<path>',
        ownerConfirmation: 'Add this folder as a Caxri Project?',
        parseParams: projectAddParameters,
        quietKey: 'project',
    },
    {
        kind: 'remote',
        path: ['session', 'list'],
        method: 'session.query',
        summary: 'List Sessions, optionally scoped to one Project ID.',
        usage: '[--project <project-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'list', { flag: '--project', key: 'projectId' }),
        quietKey: 'sessions',
    },
    {
        kind: 'remote',
        path: ['session', 'show'],
        method: 'session.query',
        summary: 'Show one exact Session by opaque ID or unambiguous name.',
        usage: '<id-or-name> [--project <project-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'show', { flag: '--project', key: 'projectId' }),
        quietKey: 'sessions',
    },
    {
        kind: 'remote',
        path: ['session', 'current'],
        method: 'session.query',
        summary: 'Show the current Session for this profile.',
        parseParams: (tokens) => ({ ...rejectOptions(tokens), mode: 'current' }),
        quietKey: 'sessions',
    },
    {
        kind: 'remote',
        path: ['session', 'search'],
        method: 'session.search',
        summary:
            'Find Agent conversations by title, ID, folder, or message text, including ones no Session holds yet.',
        usage: '[<terms>...] [--provider <provider>]... [--status all|caxri|archived|external]',
        parseParams: sessionSearchParameters,
        quietKey: 'entries',
        quietIdKey: 'key',
    },
    {
        kind: 'remote',
        path: ['session', 'import'],
        method: 'session.importConversation',
        summary:
            'Add an external conversation from `session search` as a Session in the Project holding its folder.',
        usage: '<provider>:<conversation-id> | <provider> <conversation-id>',
        parseParams: sessionImportParameters,
        quietIdKey: 'sessionId',
    },
    {
        kind: 'remote',
        path: ['session', 'rename'],
        method: 'session.rename',
        summary:
            'Rename a Session; the title stays as typed instead of following the conversation.',
        usage: '<session-id> --title <text>',
        parseParams: sessionRenameParameters,
    },
    {
        kind: 'remote',
        path: ['session', 'pin'],
        method: 'session.setPinned',
        summary: 'Pin a Session to the top of the sidebar.',
        usage: '<session-id>',
        parseParams: sessionPinParameters(true),
    },
    {
        kind: 'remote',
        path: ['session', 'unpin'],
        method: 'session.setPinned',
        summary: 'Return a pinned Session to its Project group.',
        usage: '<session-id>',
        parseParams: sessionPinParameters(false),
    },
    {
        kind: 'remote',
        path: ['terminal', 'list'],
        method: 'terminal.query',
        summary: 'List Terminals, optionally scoped to one Session ID.',
        usage: '[--session <session-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'list', { flag: '--session', key: 'sessionId' }),
        quietKey: 'terminals',
    },
    {
        kind: 'remote',
        path: ['terminal', 'show'],
        method: 'terminal.query',
        summary: 'Show one exact Terminal by opaque ID or unambiguous title.',
        usage: '<id-or-title> [--session <session-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'show', { flag: '--session', key: 'sessionId' }),
        quietKey: 'terminals',
    },
];
