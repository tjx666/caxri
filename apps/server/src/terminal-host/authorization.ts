import { isSecretMatch } from '@caxri/system';

import type {
    TerminalHostCapability,
    TerminalHostRequest,
    TerminalHostRequestEnvelope,
} from './protocol';

const requiredCapabilities = {
    'host.initialize': 'host.lifecycle',
    'host.shutdown': 'host.lifecycle',
    'terminal.reserve': 'terminal.lifecycle',
    'terminal.start': 'terminal.lifecycle',
    'terminal.agent.input': 'terminal.agent.input',
    'terminal.agent.submit': 'terminal.agent.input',
    'terminal.input': 'terminal.input',
    'terminal.resize': 'terminal.view',
    'terminal.attach': 'terminal.view',
    'terminal.detach': 'terminal.view',
    'terminal.observe': 'terminal.observe',
    'terminal.unobserve': 'terminal.observe',
    'terminal.takeOver': 'terminal.lease',
    'terminal.renewTakeOver': 'terminal.lease',
    'terminal.releaseTakeOver': 'terminal.lease',
    'terminal.observer.input': 'terminal.mobile.input',
    'terminal.observer.scroll': 'terminal.mobile.input',
    'terminal.snapshot': 'terminal.view',
    'terminal.textTail': 'terminal.inspect',
    'terminal.waitForAttachedSize': 'terminal.view',
    'terminal.signal': 'terminal.lifecycle',
    'terminal.agent.signal': 'terminal.lifecycle',
    'terminal.stop': 'terminal.lifecycle',
    'terminal.reassign': 'terminal.lifecycle',
    'terminal.resources': 'terminal.inspect',
    'terminal.recovery.configure': 'terminal.lifecycle',
    'terminal.detachAll': 'terminal.view',
    'terminal.retire': 'terminal.lifecycle',
    'terminal.runningCount': 'terminal.inspect',
} as const satisfies Record<TerminalHostRequest['method'], TerminalHostCapability>;

export interface TerminalHostAuthority {
    bootId: string;
    credential: string;
    /**
     * Permanently closed IDs stay fenced so a late reserve cannot fall through to the no-baseline rule.
     */
    isRetired(terminalId: string): boolean;
    /**
     * Undefined means this fresh Host has no generation baseline and may accept Core's first positive generation.
     */
    launchGeneration(terminalId: string): number | undefined;
    terminal(terminalId: string):
        | {
              sessionId: string;
              ptyGeneration: number;
              attachmentId?: string;
              agentLaunchId?: string;
              agentProcessId?: number;
              running?: boolean;
              /**
               * Set once `terminal.stop` is admitted for this generation, before it waits for managed Agent
               * cancellation. It is never cleared: the next generation always starts from a fresh `terminal.reserve`
               * identity.
               */
              sealed?: boolean;
          }
        | undefined;
}

export type TerminalHostAuthorizationFailure =
    | 'credential'
    | 'boot'
    | 'capability'
    | 'scope'
    | 'terminal'
    | 'session'
    | 'generation'
    | 'agent'
    | 'attachment'
    | 'retired'
    | 'sealed';

/**
 * Requests a sealed generation still accepts. They read its screen or resources, bind or release a view, release mobile
 * observation, keep its Session and provider metadata current, or repeat its stop, so none of them can deliver input,
 * resize the PTY, start observing, signal a process, or start that generation again. The stopped identity legitimately
 * receives them until the next reservation replaces it: Server Core re-attaches the view of a suspended Terminal, and a
 * suspended Terminal moved to another Session is reassigned. A repeated stop joins the stop still in flight or retries
 * one that failed; refusing it would strand a Terminal whose first stop failed after sealing, because Server Core
 * retries a failed restart barrier with the same generation. Every other generation-scoped method is refused with
 * `sealed`, so a method added later fails closed until it is deliberately listed here.
 */
const SEALED_GENERATION_METHODS: ReadonlySet<TerminalHostRequest['method']> = new Set([
    'terminal.stop',
    'terminal.attach',
    'terminal.detach',
    'terminal.snapshot',
    'terminal.textTail',
    'terminal.resources',
    'terminal.waitForAttachedSize',
    'terminal.unobserve',
    'terminal.releaseTakeOver',
    'terminal.reassign',
    'terminal.recovery.configure',
]);

/**
 * Applies the private fail-closed identity contract after structural parsing. The caller deliberately receives only a
 * reason code: credentials and peer-supplied identities must never enter logs or replies.
 */
export function authorizeTerminalHostRequest(
    envelope: TerminalHostRequestEnvelope,
    authority: TerminalHostAuthority,
): { ok: true } | { ok: false; reason: TerminalHostAuthorizationFailure } {
    if (!isSecretMatch(envelope.credential, authority.credential))
        return { ok: false, reason: 'credential' };
    if (envelope.bootId !== authority.bootId) return { ok: false, reason: 'boot' };
    const requiredCapability = requiredCapabilities[envelope.request.method];
    if (envelope.scope.capability !== requiredCapability)
        return { ok: false, reason: 'capability' };

    const isTerminalMethod =
        envelope.request.method.startsWith('terminal.') &&
        !['terminal.detachAll', 'terminal.retire', 'terminal.runningCount'].includes(
            envelope.request.method,
        );
    if (!isTerminalMethod)
        return envelope.scope.scope === 'server' ? { ok: true } : { ok: false, reason: 'scope' };
    if (envelope.scope.scope !== 'terminal') return { ok: false, reason: 'scope' };

    if (
        envelope.request.method === 'terminal.start' ||
        envelope.request.method === 'terminal.reserve'
    ) {
        const record =
            envelope.request.method === 'terminal.start'
                ? envelope.request.params.record
                : envelope.request.params;
        if (record.id !== envelope.scope.terminalId) return { ok: false, reason: 'terminal' };
        if (record.sessionId !== envelope.scope.sessionId) return { ok: false, reason: 'session' };
        if (authority.isRetired(record.id)) return { ok: false, reason: 'retired' };
        const current = authority.terminal(record.id);
        if (envelope.request.method === 'terminal.start') {
            /**
             * Server Core reserves every launch on the same Host boot before starting it, so a start with no matching
             * reservation is a late request from a generation that was stopped, discarded, retired, or lost with a
             * previous Host. Requiring the reservation fences it without any per-ID history.
             */
            if (!current) return { ok: false, reason: 'terminal' };
            if (current.sessionId !== record.sessionId) return { ok: false, reason: 'session' };
            if (current.ptyGeneration !== envelope.scope.ptyGeneration)
                return { ok: false, reason: 'generation' };
            // A stopped generation keeps `running: false` until the next reservation; only its seal refuses a late start.
            if (current.sealed) return { ok: false, reason: 'sealed' };
            if (current.running !== false) return { ok: false, reason: 'generation' };
        } else {
            /**
             * A sealed generation that is still running has a stop waiting on Agent cancellation. Admitting the next
             * generation now would let that stop's engine operations, which are keyed by Terminal ID, land on it.
             */
            if (current?.sealed && current.running) return { ok: false, reason: 'sealed' };
            const expectedGeneration = authority.launchGeneration(record.id);
            if (
                expectedGeneration !== undefined &&
                envelope.scope.ptyGeneration !== expectedGeneration
            )
                return { ok: false, reason: 'generation' };
        }
        if (envelope.scope.attachmentId !== undefined) return { ok: false, reason: 'attachment' };
        return { ok: true };
    }

    const current = authority.terminal(envelope.scope.terminalId);
    if (!current) return { ok: false, reason: 'terminal' };
    if (current.sessionId !== envelope.scope.sessionId) return { ok: false, reason: 'session' };
    if (current.ptyGeneration !== envelope.scope.ptyGeneration)
        return { ok: false, reason: 'generation' };
    if (current.sealed && !SEALED_GENERATION_METHODS.has(envelope.request.method))
        return { ok: false, reason: 'sealed' };

    if (envelope.request.method === 'terminal.attach') {
        return envelope.scope.attachmentId === envelope.request.params.attachmentId
            ? { ok: true }
            : { ok: false, reason: 'attachment' };
    }
    if (
        envelope.request.method === 'terminal.agent.input' ||
        envelope.request.method === 'terminal.agent.submit'
    ) {
        if (envelope.scope.attachmentId !== undefined) return { ok: false, reason: 'attachment' };
        return current.running &&
            current.agentLaunchId === envelope.request.params.launchId &&
            (envelope.request.method !== 'terminal.agent.submit' ||
                current.agentProcessId !== undefined)
            ? { ok: true }
            : { ok: false, reason: 'agent' };
    }
    if (
        [
            'terminal.observe',
            'terminal.unobserve',
            'terminal.takeOver',
            'terminal.renewTakeOver',
            'terminal.releaseTakeOver',
            'terminal.observer.input',
            'terminal.observer.scroll',
        ].includes(envelope.request.method)
    )
        return envelope.scope.attachmentId === undefined && current.running
            ? { ok: true }
            : { ok: false, reason: 'attachment' };
    if (
        ['terminal.input', 'terminal.resize', 'terminal.detach'].includes(envelope.request.method)
    ) {
        return envelope.scope.attachmentId !== undefined &&
            envelope.scope.attachmentId === current.attachmentId
            ? { ok: true }
            : { ok: false, reason: 'attachment' };
    }
    if (envelope.scope.attachmentId !== undefined) return { ok: false, reason: 'attachment' };
    return { ok: true };
}
