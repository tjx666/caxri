import { randomUUID } from 'node:crypto';

import type {
    AgentChatItem,
    AgentChatPermissionMode,
    AgentChatRequest,
    ApprovalDecision,
    DelegationApprovalChanged,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../../agents';
import { delegatedFixture } from '../../__tests__/delegated-sessions.fixture';
import type { DelegationAuthority } from '../../admission';
import type { AgentDelegationServiceOptions } from '../../service-options';
import type { DelegationApprovalEnvironment } from '../entry';
import type { RequestOffers } from '../fingerprint';
import { requestFingerprint, revisionOf } from '../fingerprint';

export const SECRET_COMMAND = 'rm -rf SECRET_COMMAND_TEXT';
export const SECRET_PATH = '/SECRET_PATH_TEXT/file.ts';

export type Command = Extract<AgentChatRequest, { kind: 'command' }>;
export type FileChange = Extract<AgentChatRequest, { kind: 'fileChange' }>;

export const command = (id = 'req-1', fields: Partial<Command> = {}): Command => ({
    id,
    kind: 'command',
    command: SECRET_COMMAND,
    cwd: '/SECRET_CWD_TEXT',
    ...fields,
});

/**
 * A delegating Agent (a Codex Chat whose permission the test controls) and a delegated Chat child running a started
 * task. The test plays the provider: it sets the Chat's pending requests, the offered decisions, and the delegating
 * Agent's applied permission, and reads back what the Server answered, raised, emitted, logged, and added to the Chat.
 *
 * With `chain`, the delegated Chat is itself a delegating Agent: root A delegated B, and B delegated the child C whose
 * requests the test drives. `parent` is then B (the direct delegating Agent, whose permission is `provider.permission`
 * and whose authority `decide` uses), `root` is A (permission in `provider.permissions`), and `task` is B's task.
 */
export async function approvalFixture(
    overrides: Partial<AgentDelegationServiceOptions> = {},
    {
        pathResolver,
        chain = false,
        flags = {},
    }: {
        pathResolver?: DelegationApprovalEnvironment['resolveWorkspacePath'];
        chain?: boolean;
        flags?: { independent?: true };
    } = {},
) {
    const launches = new Map<string, string>();
    const settingsListeners = new Set<() => void>();
    let parent = '';
    let child = '';
    const parentTerminalId = () => parent;
    const childTerminalId = () => child;
    const permission = {
        launchId: 'parent-launch',
        permissionMode: 'fullAccess' as AgentChatPermissionMode | undefined,
        planMode: false,
        applied: true,
    };
    const provider = {
        enabled: true,
        permission,
        requests: [] as AgentChatRequest[],
        activeTurnId: 'turn-1' as string | undefined,
        offers: { accept: true, decline: true } as RequestOffers | undefined,
        responses: [] as Array<{ requestId: string; decision: ApprovalDecision }>,
        raised: [] as AgentLifecycleSignal[],
        changes: [] as DelegationApprovalChanged[],
        items: [] as AgentChatItem[],
        respondError: undefined as Error | undefined,
        /**
         * The applied permission of every delegating Agent above the direct one, by Terminal.
         */
        permissions: new Map<string, typeof permission>(),
    };
    const write = vi.fn<StructuredLogger['write']>();
    const environment: DelegationApprovalEnvironment = {
        enabled: () => provider.enabled,
        appliedPermission: (terminalId) =>
            terminalId === parentTerminalId()
                ? provider.permission
                : provider.permissions.get(terminalId),
        chat: (terminalId) =>
            terminalId === childTerminalId()
                ? { requests: provider.requests, activeTurnId: provider.activeTurnId }
                : undefined,
        offers: () => provider.offers,
        respond: (_terminalId, requestId, decision) => {
            if (provider.respondError) throw provider.respondError;
            provider.responses.push({ requestId, decision });
            provider.requests = provider.requests.filter((request) => request.id !== requestId);
        },
        resolveWorkspacePath:
            pathResolver ??
            ((_sessionId, path) => Promise.resolve({ root: '/workspace', workspacePath: path })),
        applyItem: (_terminalId, item) => provider.items.push(item),
        raiseAttention: (signal) => {
            provider.raised.push(signal);
            return provider.requests.some((request) => request.id === signal.agentToolUseId);
        },
        onChanged: (change) => provider.changes.push(change),
        onSettingsChanged: (listener) => {
            settingsListeners.add(listener);
            return () => settingsListeners.delete(listener);
        },
    };
    const f = await delegatedFixture({
        currentLaunchId: (terminalId) => launches.get(terminalId),
        approvals: environment,
        pendingChatRequests: () => provider.requests.length,
        logger: { write } as unknown as StructuredLogger,
        ...overrides,
    });
    const root = f.authority.callerTerminalId;
    f.database.terminalSurfaces.switch(root, 'chat');
    launches.set(root, 'parent-launch');
    let task = await f.delegate(flags);
    let base = f.start(task);
    launches.set(task.terminalId, base.launchId);
    let authority: DelegationAuthority = f.authority;
    parent = root;
    if (chain) {
        // B, the Agent the first task started, delegates the task whose Chat the test drives.
        parent = task.terminalId;
        f.database.terminalSurfaces.switch(parent, 'chat');
        provider.permissions.set(root, { ...permission });
        provider.permission.launchId = base.launchId;
        authority = { ...f.authority, callerTerminalId: parent };
        f.state.clock += 1000;
        const id = randomUUID();
        const receipt = await f.service.create(id, authority, f.request);
        task = { id, receipt, terminalId: receipt.terminalId! };
        base = f.start(task);
        launches.set(task.terminalId, base.launchId);
    }
    child = task.terminalId;
    provider.activeTurnId = base.agentTurnId;
    const { approvals } = f.service;
    const owner: DelegationAuthority = { principal: { kind: 'human-cli', id: 'owner' } };
    /**
     * The provider asks for `request` (replacing any request of the same id) and signals attention: Server Core
     * classifies the signal before the coordinator sees it, then the delegation service observes it.
     */
    const ask = (request: AgentChatRequest, signal: Partial<AgentLifecycleSignal> = {}) => {
        provider.requests = [
            ...provider.requests.filter((other) => other.id !== request.id),
            request,
        ];
        const attention: AgentLifecycleSignal = {
            ...base,
            phase: 'attentionRequested',
            agentToolUseId: request.id,
            ...signal,
        };
        const alert = approvals.classify(attention);
        f.service.observe(attention);
        return alert;
    };
    /**
     * The provider no longer lists `requestId`: someone answered it, then the Chat projection changed.
     */
    const resolve = (requestId: string) => {
        provider.requests = provider.requests.filter((request) => request.id !== requestId);
        approvals.observe(child);
        f.service.observe({ ...base, phase: 'attentionResolved' });
    };
    /**
     * The revision of the request as the Chat holds it now: what a delegating Agent that just read it would echo.
     */
    const currentRevision = (requestId: string) => {
        const request = provider.requests.find((other) => other.id === requestId);
        return revisionOf(
            request ? requestFingerprint(request, provider.offers) : `missing:${requestId}`,
        );
    };
    const decide = (
        requestId: string,
        decision: ApprovalDecision = 'accept',
        as: DelegationAuthority = authority,
        revision?: string,
    ) =>
        approvals.approve(as, {
            delegationId: task.id,
            requestId,
            decision,
            revision: revision ?? currentRevision(requestId),
        });
    /**
     * Advances both clocks past the grace period: the fixture's `now` and the fake timers.
     */
    const elapse = (ms: number) => {
        f.state.clock += ms;
        vi.advanceTimersByTime(ms);
    };
    const observed = () =>
        JSON.stringify({
            changes: provider.changes,
            logs: write.mock.calls,
            raised: provider.raised,
        });
    const logged = (event: string) =>
        write.mock.calls.filter((call) => call[1] === event).map((call) => call[2]?.fields);
    return {
        ...f,
        approvals,
        authority,
        environment,
        ask,
        base,
        child,
        decide,
        elapse,
        launches,
        logged,
        observed,
        owner,
        parent,
        provider,
        resolve,
        root,
        settingsListeners,
        task,
        write,
    };
}

export function conflictError(): CaxriError {
    return new CaxriError('CONFLICT', 'This request is no longer pending');
}
