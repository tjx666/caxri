import { CaxriError, MAX_TERMINAL_INPUT_LENGTH } from '@caxri/protocol';

import { isValidAgentSubmitText } from '../../terminal-host/protocol';
import type { RemoteTerminalIdentity, TerminalHostControl } from './execution-contract';
import { terminalScope } from './execution-scope';
import type { TerminalInputQueue, TerminalInputReceipt } from './input-queue';

/**
 * Whether a Terminal with no Renderer attachment can take Agent input at all: it needs a live shell process, a live
 * managed Agent, and a payload within the single-request limit. Checked before admission, then again by the Host.
 */
function canSendAgentInput(identity: RemoteTerminalIdentity, data: string): boolean {
    if (!identity.processId || !identity.agent?.processId) return false;
    return data.length <= MAX_TERMINAL_INPUT_LENGTH;
}

/**
 * Sends Core-authorized Agent input without a Renderer attachment, fenced at both the cached launch and Terminal Host.
 */
export async function sendAgentInput(
    supervisor: TerminalHostControl,
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    terminalId: string,
    data: string,
    signal?: AbortSignal,
): Promise<{ accepted: boolean }> {
    if (signal?.aborted) throw new CaxriError('CANCELLED', 'Terminal input was canceled');
    const identity = identities.get(terminalId);
    const agentLaunchId = identity?.agent?.processId ? identity.agent.launchId : undefined;
    if (!agentLaunchId || !identity?.processId) return { accepted: false };
    if (data.length > MAX_TERMINAL_INPUT_LENGTH) return { accepted: false };
    if (data.length === 0) return { accepted: true };
    await identity.ready;
    if (signal?.aborted) throw new CaxriError('CANCELLED', 'Terminal input was canceled');
    const current = identities.get(terminalId);
    if (
        current !== identity ||
        current.agent?.launchId !== agentLaunchId ||
        current.agent.processId === undefined ||
        current.processId === undefined
    )
        return { accepted: false };
    const result = (await supervisor.request(
        {
            method: 'terminal.agent.input',
            params: { data, launchId: agentLaunchId },
        },
        terminalScope(identity, 'terminal.agent.input'),
        signal,
    )) as { accepted: boolean };
    return result;
}

/**
 * Delivers one complete Composer submission to an exact managed Agent launch. An unresolved Host request is unknown:
 * its paste may have reached the PTY even when Core lost the acknowledgement.
 */
export async function submitAgentInput(
    supervisor: TerminalHostControl,
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    terminalId: string,
    expectedSessionId: string,
    expectedAgentLaunchId: string,
    text: string,
    signal?: AbortSignal,
): Promise<'accepted' | 'rejected' | 'unknown'> {
    if (signal?.aborted || !isValidAgentSubmitText(text)) return 'rejected';
    const identity = identities.get(terminalId);
    if (
        !identity?.processId ||
        identity.record.sessionId !== expectedSessionId ||
        identity.agent?.processId === undefined ||
        identity.agent.launchId !== expectedAgentLaunchId
    )
        return 'rejected';
    try {
        await identity.ready;
    } catch {
        return 'rejected';
    }
    if (signal?.aborted) return 'rejected';
    const current = identities.get(terminalId);
    if (
        current !== identity ||
        current.record.sessionId !== expectedSessionId ||
        current.processId === undefined ||
        current.agent?.processId === undefined ||
        current.agent.launchId !== expectedAgentLaunchId
    )
        return 'rejected';
    try {
        const result = (await supervisor.request(
            {
                method: 'terminal.agent.submit',
                params: { text, launchId: expectedAgentLaunchId },
            },
            { ...terminalScope(identity, 'terminal.agent.input'), sessionId: expectedSessionId },
            signal,
        )) as { outcome: 'accepted' | 'rejected' | 'unknown' };
        return result.outcome;
    } catch (error) {
        if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'CAPABILITY_DENIED'
        )
            return 'rejected';
        return 'unknown';
    }
}

/**
 * Reports what the Terminal Host did with an Agent input that was admitted before it could answer. A rejected request
 * counts as "not delivered" too: a caller's receipt must never claim a write the Host never took.
 */
async function deliverAgentInput(
    supervisor: TerminalHostControl,
    identities: ReadonlyMap<string, RemoteTerminalIdentity>,
    terminalId: string,
    data: string,
    onDelivered?: (wasAccepted: boolean) => void,
): Promise<void> {
    let wasAccepted = false;
    try {
        wasAccepted = (await sendAgentInput(supervisor, identities, terminalId, data)).accepted;
    } finally {
        onDelivered?.(wasAccepted);
    }
}

interface AdmittedInput {
    queue?: TerminalInputQueue<RemoteTerminalIdentity>;
    receipt?: TerminalInputReceipt;
}

/**
 * Reports ordered input acknowledgement without mistaking admission or a retired queue for delivery.
 */
async function reportAgentInputDelivery(
    input: AdmittedInput,
    onDelivered: (wasAccepted: boolean) => void,
): Promise<void> {
    let wasAccepted = false;
    try {
        if (input.receipt) await input.receipt.completion.promise;
        wasAccepted = true;
    } catch {
        /**
         * Retirement or Host refusal must not be reported as successful delivery.
         */
    }
    onDelivered(wasAccepted);
}

interface AgentExactInputOptions {
    supervisor: TerminalHostControl;
    identities: ReadonlyMap<string, RemoteTerminalIdentity>;
    terminalId: string;
    data: string;
    launchId: string;
    onDelivered?: (wasAccepted: boolean) => void;
    encoding?: 'binary';
    acceptAttached(): AdmittedInput & { accepted: boolean };
    background(task: Promise<void>): void;
}

/**
 * Owns exact-launch admission and Host acknowledgement for both attached and background Agent input.
 */
export function didWriteAgentInputExact(options: AgentExactInputOptions): boolean {
    const { supervisor, identities, terminalId, data, launchId, onDelivered, encoding } = options;
    const identity = identities.get(terminalId);
    if (identity?.agent?.launchId !== launchId) return false;
    if (!identity.attachmentId) {
        if (encoding || !canSendAgentInput(identity, data)) return false;
        options.background(
            deliverAgentInput(supervisor, identities, terminalId, data, onDelivered),
        );
        return true;
    }
    const result = options.acceptAttached();
    if (onDelivered && result.accepted)
        options.background(reportAgentInputDelivery(result, onDelivered));
    return result.accepted;
}
