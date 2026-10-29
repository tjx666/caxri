import { Buffer } from 'node:buffer';

import type { CaxriMethod, ProtocolWelcome } from '@caxri/protocol';
import { CaxriError, getMethodSpec, methods } from '@caxri/protocol';

import type { CliCommandDefinition, RemoteCommandDefinition } from './types';

const MAX_PARAMS_BYTES = 1_048_576;

export const REQUEST_COMMAND = {
    kind: 'local',
    path: ['request'],
    summary:
        'Call any Server method this caller is authorized for with JSON params; the Server still enforces every permission.',
    usage: '<method> [--params <json|->]',
    parseParams: () => ({}),
} as const satisfies CliCommandDefinition;

export interface GenericRequest {
    command: RemoteCommandDefinition;
    parameters: unknown;
}

function isCaxriMethod(name: string): name is CaxriMethod {
    return Object.hasOwn(methods, name);
}

async function readStdinText(readStdin: () => Promise<string>): Promise<string> {
    const text = await readStdin();
    if (Buffer.byteLength(text) > MAX_PARAMS_BYTES)
        throw new CaxriError('VALIDATION', '--params from stdin exceeds 1 MiB');
    return text;
}

/**
 * Parses `<method> [--params <json|->]`. `-` reads the JSON from stdin so large or quote-heavy params skip shell
 * escaping.
 */
async function parseRequestTokens(
    tokens: readonly string[],
    stdin: { isTTY: boolean; read: () => Promise<string> },
): Promise<{ method: string; raw: string | undefined }> {
    let method: string | undefined;
    let raw: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--params') {
            const value = tokens.at(index + 1);
            if (value === undefined || (value !== '-' && value.startsWith('--')))
                throw new CaxriError('VALIDATION', '--params requires a JSON value or -');
            if (raw !== undefined)
                throw new CaxriError('VALIDATION', '--params may be provided only once');
            if (value === '-') {
                if (stdin.isTTY)
                    throw new CaxriError('VALIDATION', '--params - needs JSON piped to stdin');
                // eslint-disable-next-line no-await-in-loop -- at most one `--params` is accepted, so this runs once.
                raw = await readStdinText(stdin.read);
            } else raw = value;
            index += 1;
        } else if (token.startsWith('--')) {
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        } else if (method === undefined) method = token;
        else throw new CaxriError('VALIDATION', `Unexpected argument: ${token}`);
    }
    if (method === undefined)
        throw new CaxriError('VALIDATION', 'request requires a method, e.g. session.query');
    return { method, raw };
}

/**
 * Resolves the generic `request` command into the same remote command shape a dedicated command has, so transport,
 * confirmation, profile, idempotency, and output rules stay one code path. Permission is never decided here: owner-only
 * methods keep the human-owner rule, and everything else is enforced by the Server.
 */
export async function resolveGenericRequest(
    tokens: readonly string[],
    stdin: { isTTY: boolean; read: () => Promise<string> },
): Promise<GenericRequest> {
    const { method, raw } = await parseRequestTokens(tokens, stdin);
    if (!isCaxriMethod(method))
        throw new CaxriError('VALIDATION', `Unknown Server method: ${method}`, {
            hint: 'Run `caxri capabilities --json` and read requestMethods.',
        });
    let parameters: unknown = {};
    if (raw !== undefined) {
        try {
            parameters = JSON.parse(raw);
        } catch {
            throw new CaxriError('VALIDATION', '--params is not valid JSON');
        }
    }
    return {
        command: {
            confirmation: `Run ${method} on the selected Caxri profile?`,
            kind: 'remote',
            method,
            parseParams: () => parameters,
            path: ['request'],
            requiresHumanOwner: getMethodSpec(method)?.principal === 'owner',
            summary: REQUEST_COMMAND.summary,
        },
        parameters,
    };
}

/**
 * Validates the final params (after `--timeout` mapping) against the protocol schema before connecting.
 */
export function validateRequestParameters(method: CaxriMethod, parameters: unknown): void {
    const parsed = methods[method].params.safeParse(parameters);
    if (parsed.success) return;
    const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    throw new CaxriError('VALIDATION', `Invalid params for ${method}: ${detail}`);
}

/**
 * A method the Server did not offer is FORBIDDEN when this principal lacks one of its capabilities, and CONFLICT only
 * when the capabilities are held (an older Server that does not know the method).
 */
export function assertMethodOffered(method: CaxriMethod, welcome: ProtocolWelcome): void {
    if (welcome.commands.includes(method)) return;
    const missing = methods[method].requiredCapabilities.filter(
        (capability) => !welcome.capabilities.includes(capability),
    );
    if (missing.length > 0)
        throw new CaxriError('FORBIDDEN', `This caller is not authorized to call ${method}`, {
            missingCapabilities: missing,
        });
    throw new CaxriError('CONFLICT', `The Caxri Server does not support command ${method}`);
}
