import { CaxriError, logQueryParametersSchema, settingsPatchChangeSchema } from '@caxri/protocol';

export function desktopTarget(
    tokens: readonly string[],
    options: { launchByDefault: boolean },
): Record<string, unknown> {
    const positional: string[] = [];
    let isLaunchIfNeeded = options.launchByDefault;
    let sessionId: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--launch' || token === '--no-launch') {
            isLaunchIfNeeded = token === '--launch';
            continue;
        }
        if (token === '--session') {
            const value = tokens[index + 1];
            if (!value || value.startsWith('--'))
                throw new CaxriError('VALIDATION', '--session requires a value');
            if (sessionId)
                throw new CaxriError('VALIDATION', '--session may be provided only once');
            sessionId = value;
            index += 1;
            continue;
        }
        if (token.startsWith('--'))
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        positional.push(token);
    }
    if (positional.length !== 1)
        throw new CaxriError('VALIDATION', 'Desktop commands require exactly one path');
    return {
        path: positional[0],
        launchIfNeeded: isLaunchIfNeeded,
        ...(sessionId && { sessionId }),
    };
}

export function settingPatch(
    tokens: readonly string[],
    isForceDryRun: boolean,
): Record<string, unknown> {
    const changes: unknown[] = [];
    let isDryRun = isForceDryRun;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--dry-run' && !isForceDryRun) {
            isDryRun = true;
            continue;
        }
        if (token !== '--set')
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        const assignment = tokens[index + 1];
        if (!assignment || assignment.startsWith('--'))
            throw new CaxriError('VALIDATION', '--set requires key=value');
        const separator = assignment.indexOf('=');
        if (separator < 1) throw new CaxriError('VALIDATION', '--set requires key=value');
        const key = assignment.slice(0, separator);
        const source = assignment.slice(separator + 1);
        let value: unknown;
        try {
            value = JSON.parse(source) as unknown;
        } catch {
            value = source;
        }
        changes.push(settingsPatchChangeSchema.parse({ key, value }));
        index += 1;
    }
    if (changes.length === 0)
        throw new CaxriError('VALIDATION', 'At least one --set key=value is required');
    return { changes, dryRun: isDryRun };
}

export function logQuery(tokens: readonly string[]): Record<string, unknown> {
    const keys = new Map([
        ['--after', 'afterCursor'],
        ['--correlation-id', 'correlationId'],
        ['--event', 'event'],
        ['--level', 'level'],
        ['--limit', 'limit'],
        ['--process', 'process'],
        ['--since', 'since'],
    ]);
    const result: Record<string, unknown> = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const key = keys.get(token);
        if (!key) throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        const value = tokens[index + 1];
        if (!value || value.startsWith('--'))
            throw new CaxriError('VALIDATION', `${token} requires a value`);
        result[key] = key === 'limit' ? Number(value) : value;
        index += 1;
    }
    return logQueryParametersSchema.parse(result);
}

export function eventRecovery(tokens: readonly string[]): Record<string, number> {
    if (tokens.length === 0) return { afterCursor: 0 };
    if (tokens.length !== 2 || tokens[0] !== '--after')
        throw new CaxriError('VALIDATION', `Unknown option: ${tokens[0].split('=', 1)[0]}`);
    const afterCursor = Number(tokens[1]);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
        throw new CaxriError('VALIDATION', '--after must be a non-negative integer cursor');
    return { afterCursor };
}

export function endpointReference(source: string | undefined) {
    const [hostId, endpointId, generationSource, ...extra] = source?.split(':') ?? [];
    const generation = Number(generationSource);
    if (
        !hostId ||
        !endpointId ||
        extra.length > 0 ||
        !Number.isSafeInteger(generation) ||
        generation < 1
    )
        throw new CaxriError(
            'VALIDATION',
            'Endpoint ref must be <host-id>:<endpoint-id>:<generation>',
        );
    return { hostId, endpointId, generation };
}

export function agentGrant(tokens: readonly string[]): Record<string, unknown> {
    if (tokens.length < 2)
        throw new CaxriError('VALIDATION', 'agent grant requires an Endpoint ref and policy');
    const result: Record<string, unknown> = {
        endpoint: endpointReference(tokens[0]),
        policy: tokens[1],
    };
    if (tokens.length > 2) {
        if (tokens.length !== 4 || tokens[2] !== '--ttl-ms')
            throw new CaxriError('VALIDATION', `Unknown option: ${tokens[2]}`);
        result.ttlMs = Number(tokens[3]);
    }
    return result;
}

/**
 * Where a person finds the value of a required ID option, appended to the missing-option error.
 */
const requiredOptionHints = new Map([
    ['projectId', 'caxri project list'],
    ['sessionId', 'caxri session list'],
    ['terminalId', 'caxri terminal list'],
]);

function namedOptions(
    tokens: readonly string[],
    allowed: ReadonlyMap<string, string>,
    required: readonly string[],
): Partial<Record<string, string>> {
    // Partial (not Record<string, string>): keys are populated incrementally below, so the runtime
    // shape genuinely allows `undefined` until the `required` loop validates presence.
    const result: Partial<Record<string, string>> = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const flag = tokens[index];
        const key = allowed.get(flag);
        if (!key) throw new CaxriError('VALIDATION', `Unknown option: ${flag.split('=', 1)[0]}`);
        if (result[key] !== undefined)
            throw new CaxriError('VALIDATION', `${flag} may be provided only once`);
        const value = tokens[index + 1];
        if (!value || value.startsWith('--'))
            throw new CaxriError('VALIDATION', `${flag} requires a value`);
        result[key] = value;
        index += 1;
    }
    for (const key of required) {
        if (result[key] === undefined) {
            const flag = `--${key.replaceAll(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`;
            const listing = requiredOptionHints.get(key);
            throw new CaxriError(
                'VALIDATION',
                listing
                    ? `${flag} is required: pass ${flag} <id>; list them with \`${listing}\``
                    : `${flag} is required`,
            );
        }
    }
    return result;
}

export function agentMessage(tokens: readonly string[], isReply: boolean): Record<string, unknown> {
    let isWake = false;
    const valueTokens: string[] = [];
    for (const token of tokens) {
        if (token === '--wake') {
            if (isWake) throw new CaxriError('VALIDATION', '--wake may be provided only once');
            isWake = true;
        } else valueTokens.push(token);
    }
    const options = namedOptions(
        valueTokens,
        new Map([
            ['--to', 'to'],
            ['--body', 'body'],
            ['--reply-to', 'replyTo'],
            ['--ttl-ms', 'ttlMs'],
        ]),
        isReply ? ['to', 'body', 'replyTo'] : ['to', 'body'],
    );
    if (!isReply && options.replyTo !== undefined)
        throw new CaxriError('VALIDATION', '--reply-to is valid only for agent message reply');
    if (isReply && isWake)
        throw new CaxriError('VALIDATION', '--wake is valid only for agent message send');
    return {
        to: endpointReference(options.to),
        body: options.body,
        ...(options.replyTo && { replyTo: options.replyTo }),
        ...(options.ttlMs && { ttlMs: Number(options.ttlMs) }),
        ...(isWake && { wake: true }),
    };
}

export function dispatchTarget(
    tokens: readonly string[],
    isResume: boolean,
): Record<string, unknown> {
    const options = namedOptions(
        tokens,
        new Map([
            ['--project', 'projectId'],
            ['--session', 'sessionId'],
            ['--provider', 'provider'],
            ['--terminal', 'terminalId'],
            ['--provider-session', 'providerSessionId'],
        ]),
        isResume
            ? ['projectId', 'sessionId', 'terminalId', 'providerSessionId']
            : ['projectId', 'sessionId', 'provider'],
    );
    if (isResume && options.provider !== undefined)
        throw new CaxriError('VALIDATION', '--provider is valid only for agent dispatch start');
    if (!isResume && (options.terminalId !== undefined || options.providerSessionId !== undefined))
        throw new CaxriError(
            'VALIDATION',
            '--terminal and --provider-session are valid only for agent dispatch resume',
        );
    return options;
}

export function dispatchWait(tokens: readonly string[]): Record<string, unknown> {
    const positional: string[] = [];
    let afterRevision = 0;
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] !== '--after-revision') {
            positional.push(tokens[index]);
            continue;
        }
        const value = Number(tokens[index + 1]);
        if (!Number.isSafeInteger(value) || value < 0)
            throw new CaxriError('VALIDATION', '--after-revision requires a non-negative integer');
        afterRevision = value;
        index += 1;
    }
    if (positional.length !== 1)
        throw new CaxriError('VALIDATION', 'agent dispatch wait requires one dispatch ID');
    return { dispatchId: positional[0], afterRevision };
}

export function terminalSend(tokens: readonly string[]): Record<string, unknown> {
    let isEnter = false;
    const valueTokens: string[] = [];
    for (const token of tokens) {
        if (token === '--enter') {
            if (isEnter) throw new CaxriError('VALIDATION', '--enter may be provided only once');
            isEnter = true;
        } else valueTokens.push(token);
    }
    const options = namedOptions(
        valueTokens,
        new Map([
            ['--terminal', 'terminalId'],
            ['--text', 'text'],
        ]),
        ['terminalId', 'text'],
    );
    return { ...options, enter: isEnter };
}
