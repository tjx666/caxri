import type { MethodResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { rejectOptions } from './reject-options';
import type { RemoteCommandDefinition, RemoteCommandRunContext } from './types';

interface DeviceOptions {
    deviceId?: string;
    cwd?: string;
    rest: string[];
}

/**
 * Splits `--device` (and, when `isCwdAllowed`, `--cwd`) from the positional tokens. Everything after `--` is
 * positional, so a phone command's own flags never reach this parser.
 */
function deviceOptions(tokens: readonly string[], isCwdAllowed: boolean): DeviceOptions {
    const options: DeviceOptions = { rest: [] };
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--') {
            options.rest.push(...tokens.slice(index + 1));
            break;
        }
        const hasValue = index + 1 < tokens.length;
        const value = tokens[index + 1];
        if (hasValue && token === '--device' && options.deviceId === undefined) {
            options.deviceId = value;
            index += 1;
        } else if (isCwdAllowed && hasValue && token === '--cwd' && options.cwd === undefined) {
            options.cwd = value;
            index += 1;
        } else if (token.startsWith('-'))
            throw new CaxriError('VALIDATION', `Unexpected argument: ${token.split('=', 1)[0]}`);
        else options.rest.push(token);
    }
    return options;
}

function openParameters(tokens: readonly string[]) {
    const { deviceId, rest } = deviceOptions(tokens, false);
    if (rest.length !== 1)
        throw new CaxriError('VALIDATION', 'device open requires exactly one <url>');
    return { ...(deviceId !== undefined && { deviceId }), url: rest[0] };
}

function execParameters(tokens: readonly string[]) {
    const separator = tokens.indexOf('--');
    const { deviceId, cwd, rest } = deviceOptions(
        separator === -1 ? tokens : tokens.slice(0, separator),
        true,
    );
    const argv = separator === -1 ? [] : tokens.slice(separator + 1);
    if (rest.length > 0 || argv.length === 0)
        throw new CaxriError(
            'VALIDATION',
            'device exec requires [--device <id>] [--cwd <dir>] -- <command> [args...]',
        );
    return {
        ...(deviceId !== undefined && { deviceId }),
        ...(cwd !== undefined && { cwd }),
        argv,
    };
}

/**
 * Prints the phone command's output as its own and exits with its exit code, so `caxri device exec` composes like a
 * local command. `--json` prints the whole result instead.
 */
async function runExec(context: RemoteCommandRunContext): Promise<number> {
    const result = (await context.request(
        'mobile.deviceAction.exec',
        context.parameters,
    )) as MethodResult<'mobile.deviceAction.exec'>;
    if (context.json) {
        context.writeStdout(`${JSON.stringify(result)}\n`);
        return 0;
    }
    if (result.stdout) context.writeStdout(result.stdout);
    if (result.stderr) context.writeStderr(result.stderr);
    if (result.truncated) context.writeStderr('\n[caxri: output was cut to fit one message]\n');
    return result.exitCode;
}

/**
 * Commands that act on a paired phone. The phone must be connected with Caxri open; `exec` also needs Termux and the
 * phone's "Termux commands" setting. See `docs/mobile/device-actions.md`.
 */
export const DEVICE_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['device', 'list'],
        method: 'mobile.deviceAction.targets',
        summary: 'List paired phones and whether each is connected right now.',
        parseParams: rejectOptions,
        quietKey: 'devices',
        quietIdKey: 'deviceId',
    },
    {
        kind: 'remote',
        path: ['device', 'open'],
        method: 'mobile.deviceAction.openUrl',
        summary: 'Open a link on the connected phone.',
        usage: '[--device <id>] <url>',
        parseParams: openParameters,
        quietIdKey: 'deviceId',
    },
    {
        kind: 'remote',
        path: ['device', 'exec'],
        method: 'mobile.deviceAction.exec',
        summary:
            'Run a command in Termux on the connected Android phone; prints its output and exits with its code.',
        usage: '[--device <id>] [--cwd <dir>] [--timeout <ms>] -- <command> [args...]',
        parseParams: execParameters,
        run: runExec,
    },
];
