import { resolve } from 'node:path';

import { CaxriError } from '@caxri/protocol';

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

/**
 * Project, Session, and Terminal record queries, and adding a folder as a Project.
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
