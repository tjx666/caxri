import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import process from 'node:process';

import type { AgentSecretRequestStatus, MethodResult } from '@caxri/protocol';
import { agentSecretNameSchema, CaxriError } from '@caxri/protocol';

import { rejectOptions } from './reject-options';
import type { RemoteCommandDefinition, RemoteCommandRunContext } from './types';

/**
 * How long one `caxri secret request` waits for the user before handing control back to the Agent. It stays below
 * Claude Code's two-minute default Bash timeout, so the Agent reads "still waiting" instead of a killed command.
 * Running the same command again joins the open request rather than raising a second card.
 */
const SECRET_REQUEST_WAIT_MS = 100_000;
const SECRET_WAIT_POLL_MS = 30_000;

function secretName(token: string): string {
    const parsed = agentSecretNameSchema.safeParse(token);
    if (!parsed.success)
        throw new CaxriError(
            'VALIDATION',
            `Invalid secret name ${token}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
    return parsed.data;
}

function requestParameters(tokens: readonly string[]) {
    let name: string | undefined;
    let reason: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--reason' && reason === undefined && index + 1 < tokens.length) {
            reason = tokens[index + 1];
            index += 1;
        } else if (name === undefined && !token.startsWith('-')) name = secretName(token);
        else throw new CaxriError('VALIDATION', `Unexpected argument: ${token.split('=', 1)[0]}`);
    }
    if (!name || !reason?.trim())
        throw new CaxriError(
            'VALIDATION',
            'secret request requires <NAME> --reason <why you need it>',
        );
    return { name, reason };
}

interface ExecParameters {
    names: string[];
    command: [string, ...string[]];
}

function execParameters(tokens: readonly string[]): ExecParameters {
    const separator = tokens.indexOf('--');
    const names = (separator === -1 ? tokens : tokens.slice(0, separator)).map((token) => {
        if (token.startsWith('-'))
            throw new CaxriError('VALIDATION', `Unexpected argument: ${token.split('=', 1)[0]}`);
        return secretName(token);
    });
    const command = separator === -1 ? [] : tokens.slice(separator + 1);
    if (names.length === 0 || command.length === 0)
        throw new CaxriError('VALIDATION', 'secret exec requires <NAME>... -- <command> [args...]');
    if (new Set(names).size !== names.length)
        throw new CaxriError('VALIDATION', 'Each secret name may be given only once');
    return { names, command: command as [string, ...string[]] };
}

const unanswered: Record<
    Exclude<AgentSecretRequestStatus, 'pending' | 'saved'>,
    (name: string) => CaxriError
> = {
    declined: (name) =>
        new CaxriError(
            'CANCELLED',
            `The user declined to provide ${name}. Continue without it, or ask the user how to proceed.`,
        ),
    expired: (name) =>
        new CaxriError(
            'TIMEOUT',
            `The request for ${name} expired before the user answered. Ask the user before requesting it again.`,
        ),
    cancelled: (name) =>
        new CaxriError(
            'CANCELLED',
            `The request for ${name} was withdrawn before the user answered.`,
        ),
};

function writeOutcome(context: RemoteCommandRunContext, name: string, status: string): void {
    context.writeStdout(
        context.json
            ? `${JSON.stringify({ name, status })}\n`
            : `${name} is ready. Run your command with \`caxri secret exec ${name} -- <command>\`.\n`,
    );
}

async function waitForAnswer(
    context: RemoteCommandRunContext,
    requestId: string,
): Promise<AgentSecretRequestStatus> {
    const deadline = Date.now() + SECRET_REQUEST_WAIT_MS;
    let status: AgentSecretRequestStatus = 'pending';
    while (status === 'pending' && !context.signal?.aborted) {
        const remaining = deadline - Date.now();
        if (remaining < 100) break;
        // eslint-disable-next-line no-await-in-loop -- each long poll starts only after the previous one returned pending.
        const result = (await context.request('agent.secret.wait', {
            requestId,
            timeoutMs: Math.min(SECRET_WAIT_POLL_MS, remaining),
        })) as MethodResult<'agent.secret.wait'>;
        ({ status } = result);
    }
    return status;
}

async function runRequest(context: RemoteCommandRunContext): Promise<number> {
    const { name, reason } = context.parameters as ReturnType<typeof requestParameters>;
    const first = (await context.request('agent.secret.request', {
        name,
        reason,
    })) as MethodResult<'agent.secret.request'>;
    if (first.status === 'available') {
        writeOutcome(context, name, 'available');
        return 0;
    }
    context.writeStderr(`Waiting for the user to provide ${name} in Caxri...\n`);
    const status = await waitForAnswer(context, first.requestId);
    if (context.signal?.aborted) return 130;
    if (status === 'pending')
        throw new CaxriError(
            'TIMEOUT',
            `The user has not answered the request for ${name} yet; it is still open in Caxri. Run the same command again to keep waiting.`,
            { requestId: first.requestId },
        );
    if (status !== 'saved') throw unanswered[status](name);
    writeOutcome(context, name, 'saved');
    return 0;
}

/**
 * Runs the child with the secrets added to its environment and reports its exit status as its own: a signal death
 * becomes `128 + signal`, the shell convention. Ctrl-C reaches the child through the Terminal's process group; a
 * `SIGTERM` or `SIGHUP` sent only to this process is forwarded so the child never outlives it.
 */
function runChild(
    command: [string, ...string[]],
    environment: NodeJS.ProcessEnv,
    cwd: string,
): Promise<number> {
    const [file, ...arguments_] = command;
    return new Promise((resolve, reject) => {
        const child = spawn(file, arguments_, { cwd, env: environment, stdio: 'inherit' });
        const forwarded = ['SIGTERM', 'SIGHUP'] as const;
        const forward = (signal: NodeJS.Signals) => child.kill(signal);
        for (const signal of forwarded) process.on(signal, forward);
        const cleanup = () => {
            for (const signal of forwarded) process.removeListener(signal, forward);
        };
        child.once('error', (error: NodeJS.ErrnoException) => {
            cleanup();
            reject(
                error.code === 'ENOENT'
                    ? new CaxriError('NOT_FOUND', `Command not found: ${file}`)
                    : new CaxriError('IO', `Could not start ${file}: ${error.code ?? 'unknown'}`),
            );
        });
        child.once('exit', (code, signal) => {
            cleanup();
            resolve(signal ? 128 + constants.signals[signal] : (code ?? 1));
        });
    });
}

async function runExec(context: RemoteCommandRunContext): Promise<number> {
    const { names, command } = context.parameters as ExecParameters;
    const { values } = (await context.request('agent.secret.resolve', {
        names,
    })) as MethodResult<'agent.secret.resolve'>;
    return runChild(command, { ...context.environment, ...values }, context.cwd);
}

/**
 * How an Agent uses a secret without the value entering its conversation: it asks the user through a Caxri card instead
 * of chat, and runs the command that needs the secret through `exec`, which exports the value to that child only. No
 * command prints a value.
 */
export const SECRET_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['secret', 'list'],
        method: 'agent.secret.list',
        summary: 'List the secret names this Project can use, never their values.',
        parseParams: rejectOptions,
        quietKey: 'secrets',
        quietIdKey: 'name',
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['secret', 'request'],
        method: 'agent.secret.request',
        summary:
            'Ask the user for a missing secret in Caxri, then wait for the answer. The value never reaches you.',
        usage: '<NAME> --reason <why you need it>',
        parseParams: requestParameters,
        requiresAgentEndpoint: true,
        run: runRequest,
    },
    {
        kind: 'remote',
        path: ['secret', 'exec'],
        method: 'agent.secret.resolve',
        summary:
            'Run a command with saved secrets exported as environment variables; prints only the command output.',
        usage: '<NAME>... -- <command> [args...]',
        parseParams: execParameters,
        requiresAgentEndpoint: true,
        run: runExec,
    },
];
