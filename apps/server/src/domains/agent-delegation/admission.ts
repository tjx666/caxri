import type {
    AgentDelegationCreate,
    AgentDelegationSettings,
    AgentLaunchSettings,
    AgentProvider,
    DelegationRoster,
    DelegationSelection,
    Principal,
    TerminalRecord,
} from '@caxri/protocol';
import {
    CaxriError,
    delegationProviderSchema,
    isDelegationEffortSupported,
    isTopLevelProject,
} from '@caxri/protocol';

/**
 * Provider launch selection stays behind the agents domain's public API.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { delegationAdapter } from '../agents';
import type { CaxriDatabase, StoredAgentDelegation } from '../db';
import { validateDelegationLaunch } from './launch';

export interface DelegationAuthority {
    principal: Principal;
    callerTerminalId?: string;
}

/**
 * The Agent Commander is recognized by its exact Terminal and system Project, both recorded by domain services when
 * they created it; a capability or Project claim alone never qualifies a caller.
 */
export function isAgentCommanderCaller(
    database: CaxriDatabase,
    authority: DelegationAuthority,
): boolean {
    const commander = database.agentCommanderRows();
    return Boolean(
        commander?.terminalId &&
        authority.principal.kind === 'agent' &&
        authority.callerTerminalId === commander.terminalId &&
        authority.principal.projectIds.length === 1 &&
        authority.principal.projectIds[0] === commander.projectId,
    );
}

/**
 * The Terminal a child pane splits beside and inherits its cwd from: the caller, but only when it lives in the target
 * Session. The Agent Commander keeps `callerTerminalId` for ownership and depth, but delegates from its own window into
 * another Session and, like an external caller, fills that Session's pane instead.
 */
export function delegationPaneCaller(
    database: CaxriDatabase,
    authority: DelegationAuthority,
    target: { sessionId: string },
): TerminalRecord | undefined {
    const caller = authority.callerTerminalId && database.getTerminal(authority.callerTerminalId);
    return caller && caller.sessionId === target.sessionId ? caller : undefined;
}

/**
 * `create` admits new work: a task, its follow-up or resume, and every re-check up to its launch. `existing` admits
 * reading, waiting on, or stopping a task the caller already started.
 */
export type DelegationAccess = 'create' | 'existing';

/**
 * Admits a caller to a delegation Session. For the Agent Commander, `existing` access skips the create-only limits
 * below, which decide where new work may go: the task's owner was proven when it was created and `owned` re-checks the
 * caller Terminal, so archiving the Session or hiding its Project must not cut the Commander off from a result it is
 * still waiting for.
 */
export function authorizeDelegationSession(
    database: CaxriDatabase,
    authority: DelegationAuthority,
    input: Pick<AgentDelegationCreate, 'projectId' | 'sessionId'>,
    access: DelegationAccess = 'create',
): void {
    const session = database.getSession(input.sessionId);
    if (!session || session.projectId !== input.projectId)
        throw new CaxriError('NOT_FOUND', 'Delegation Session is unavailable');
    if (authority.principal.kind === 'human-cli' || authority.principal.kind === 'desktop') return;
    if (isAgentCommanderCaller(database, authority)) {
        if (access === 'existing') return;
        /**
         * Only Sessions the Commander created itself, in a Project the user can still see: delegating into a busy user
         * Session would split its active pane, and the Commander never widens into control or dispatch.
         */
        const project = database
            .listVisibleProjects()
            .find((candidate) => candidate.id === input.projectId);
        if (
            !project ||
            !isTopLevelProject(project) ||
            session.archivedAt !== undefined ||
            !database.agentCommanderRows()?.sessionIds.includes(input.sessionId)
        )
            throw new CaxriError(
                'FORBIDDEN',
                'The Agent Commander may delegate only into Sessions it created',
            );
        return;
    }
    if (authority.principal.kind === 'delegation-client') {
        if (
            authority.principal.projectIds[0] !== input.projectId ||
            authority.principal.sessionId !== input.sessionId
        )
            throw new CaxriError(
                'FORBIDDEN',
                'Delegation must remain in the authorized external Session',
            );
        return;
    }
    if (
        authority.principal.kind !== 'agent' ||
        !authority.principal.projectIds.includes(input.projectId)
    )
        throw new CaxriError('FORBIDDEN', 'Delegation requires an authorized Agent or owner');
    const caller = authority.callerTerminalId && database.getTerminal(authority.callerTerminalId);
    if (!caller || caller.sessionId !== input.sessionId)
        throw new CaxriError('FORBIDDEN', 'Delegation must remain in the caller Session');
}

/**
 * Caller identity comes from the authenticated Terminal, never a caller-supplied ancestry claim.
 */
export function delegationCaller(
    database: CaxriDatabase,
    authority: DelegationAuthority,
    requested?: DelegationSelection['provider'],
) {
    if (authority.principal.kind === 'delegation-client') {
        if (requested && requested !== authority.principal.callerProvider)
            throw new CaxriError(
                'FORBIDDEN',
                'Delegation caller must match its authorized provider',
            );
        return authority.principal.callerProvider;
    }
    if (authority.principal.kind !== 'agent') return requested;
    const terminal = authority.callerTerminalId
        ? database.getTerminal(authority.callerTerminalId)
        : undefined;
    const provider = delegationProviderSchema.safeParse(terminal?.provider);
    if (!provider.success || (requested && requested !== provider.data))
        throw new CaxriError(
            'FORBIDDEN',
            'Delegation caller must match its authenticated Terminal',
        );
    return provider.data;
}

/**
 * A caller binding replaces the complete provider/model/effort tuple; descriptions fall back individually.
 */
export function delegationRoster(
    settings: AgentDelegationSettings,
    caller?: DelegationSelection['provider'],
): DelegationRoster {
    const binding = caller ? settings.callers[caller] : undefined;
    const excluded = new Set(binding?.exclude);
    return {
        maxDepth: settings.maxDepth,
        prepend: binding?.prepend,
        append: binding?.append,
        presets: settings.presets.flatMap((preset) => {
            if (excluded.has(preset.name)) return [];
            const overrides = binding?.presets;
            const override =
                overrides && Object.hasOwn(overrides, preset.name)
                    ? overrides[preset.name]
                    : undefined;
            return [
                {
                    name: preset.name,
                    provider: override?.provider ?? preset.provider,
                    model: override ? override.model : preset.model,
                    effort: override ? override.effort : preset.effort,
                    useWhen: override?.useWhen ?? preset.useWhen,
                    dontUseWhen: override?.dontUseWhen ?? preset.dontUseWhen,
                },
            ];
        }),
    };
}

export function resolveDelegationAdmission(options: {
    database: CaxriDatabase;
    authority: DelegationAuthority;
    input: AgentDelegationCreate;
    previous?: StoredAgentDelegation;
    settings: AgentDelegationSettings;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    currentLaunchId?(terminalId: string): string | undefined;
}) {
    const { input, previous, settings, database, authority } = options;
    const caller = delegationCaller(database, authority, input.callerProvider);
    const roster = delegationRoster(settings, caller);
    let selection: DelegationSelection;
    let instructions: string | undefined;
    if (previous) {
        selection = previous.receipt.selection ?? { provider: previous.receipt.provider };
        if (
            previous.input.projectId !== input.projectId ||
            previous.input.sessionId !== input.sessionId
        )
            throw new CaxriError('FORBIDDEN', 'Follow-up must remain in its original Session');
        if (
            (input.provider && input.provider !== selection.provider) ||
            (input.preset && input.preset !== selection.preset) ||
            (input.model && input.model !== selection.model) ||
            (input.effort && input.effort !== selection.effort)
        )
            throw new CaxriError(
                'FORBIDDEN',
                'Follow-up must preserve its original delegation selection',
            );
        instructions = previous.frozenInstructions;
    } else if (input.preset) {
        const preset = roster.presets.find((entry) => entry.name === input.preset);
        if (!preset)
            throw new CaxriError('FORBIDDEN', 'Delegation preset is unavailable to this caller');
        selection = {
            provider: preset.provider,
            model: preset.model,
            effort: preset.effort,
            preset: preset.name,
        };
        instructions = settings.presets.find((entry) => entry.name === input.preset)?.instructions;
    } else {
        if (!input.provider)
            throw new CaxriError('VALIDATION', 'Delegation requires a provider or preset');
        selection = { provider: input.provider, model: input.model, effort: input.effort };
    }
    if (!isDelegationEffortSupported(selection.provider, selection.model, selection.effort))
        throw new CaxriError('VALIDATION', 'Unsupported delegation effort for the selected model');
    const launch = structuredClone(
        previous?.frozenLaunch ?? options.launchSettings(selection.provider),
    );
    // Validate before replacement so forbidden launch overrides cannot disappear during normalization.
    validateDelegationLaunch(selection.provider, launch);
    const frozenLaunch =
        previous || (!input.preset && !input.model && !input.effort)
            ? launch
            : delegationAdapter(selection.provider).selectLaunch(launch, selection);
    const callerLaunch =
        authority.callerTerminalId && options.currentLaunchId?.(authority.callerTerminalId);
    const parent =
        callerLaunch && authority.callerTerminalId
            ? database.agentDelegations
                  .forTerminal(authority.callerTerminalId)
                  .filter((record) => record.launchId === callerLaunch)
                  .toSorted((a, b) => b.receipt.createdAt - a.receipt.createdAt)[0]
            : undefined;
    const depth = previous?.receipt.depth ?? (parent ? (parent.receipt.depth ?? 1) + 1 : 1);
    if (depth > settings.maxDepth)
        throw new CaxriError('FORBIDDEN', 'Delegation exceeds the configured maximum depth');
    return {
        selection,
        frozenLaunch,
        frozenInstructions: instructions,
        depth,
        parentDelegationId: previous?.receipt.parentDelegationId ?? parent?.receipt.delegationId,
    };
}

/**
 * The durable record of a newly admitted task, before anything launches. A follow-up or resume continues its parent's
 * native conversation and transcript position; a new task gets a fresh conversation.
 */
export function admittedDelegation(options: {
    id: string;
    now: number;
    authority: DelegationAuthority;
    input: AgentDelegationCreate;
    fingerprint: string;
    admission: ReturnType<typeof resolveDelegationAdmission>;
    previous: StoredAgentDelegation | undefined;
    /**
     * The conversation a hand-over continues; a new root task otherwise gets a fresh one.
     */
    providerSessionId?: string;
}): StoredAgentDelegation {
    const { id, now, authority, input, admission, previous } = options;
    const provider = admission.selection.provider;
    return {
        receipt: {
            delegationId: id,
            projectId: input.projectId,
            sessionId: input.sessionId,
            callerTerminalId: authority.callerTerminalId,
            followUpOf: input.followUpOf,
            resumeFrom: input.resumeFrom,
            provider,
            selection: admission.selection,
            depth: admission.depth,
            parentDelegationId: admission.parentDelegationId,
            status: 'requested',
            revision: 1,
            createdAt: now,
            updatedAt: now,
        },
        principal: authority.principal,
        input,
        fingerprint: options.fingerprint,
        frozenLaunch: admission.frozenLaunch,
        frozenInstructions: admission.frozenInstructions,
        providerSessionId:
            options.providerSessionId ??
            previous?.providerSessionId ??
            delegationAdapter(provider).createSessionId(),
        transcriptOffset: previous?.transcriptOffset,
        rootDelegationId: previous?.rootDelegationId ?? previous?.receipt.delegationId ?? id,
        promptDigest: '',
    };
}
