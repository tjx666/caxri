import { createHash } from 'node:crypto';

import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    AgentDelegationSettings,
    AgentLaunchSettings,
    AgentProvider,
    DelegationRoster,
    DelegationSelection,
    DelegationType,
    Principal,
    TerminalRecord,
} from '@caxri/protocol';
import {
    CaxriError,
    defaultDelegationTypeProvider,
    DELEGATION_TYPES,
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
import { resolveChildSurface } from './chat-child';
import { DELEGATION_TYPE_INSTRUCTIONS } from './delegation-types';
import { validateDelegationLaunch } from './launch';

export interface DelegationAuthority {
    principal: Principal;
    callerTerminalId?: string;
}

/**
 * Caxri Bot is recognized by its exact Terminal and system Project, both recorded by domain services when they created
 * it; a capability or Project claim alone never qualifies a caller.
 */
export function isCaxriBotCaller(database: CaxriDatabase, authority: DelegationAuthority): boolean {
    const bot = database.caxriBotRows();
    return Boolean(
        bot?.terminalId &&
        authority.principal.kind === 'agent' &&
        authority.callerTerminalId === bot.terminalId &&
        authority.principal.projectIds.length === 1 &&
        authority.principal.projectIds[0] === bot.projectId,
    );
}

/**
 * The Terminal a child pane splits beside and inherits its cwd from: the caller, but only when it lives in the target
 * Session. Caxri Bot keeps `callerTerminalId` for ownership and depth, but delegates from its own window into another
 * Session and, like an external caller, fills that Session's pane instead.
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
 * Whether two principals are the same caller: the exact Endpoint or delegation generation, never a shared client or a
 * sibling that merely names the same Project. The one comparison ownership, proof of creation and the task cap share.
 */
export function isSamePrincipal(a: Principal, b: Principal): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A delegation client works from its anchor Session, the shared dedicated Session of its Project and provider (titled
 * `External <Provider>`), and from the Sessions it created from there for a task, in any Project the user can still
 * see. The anchor is shared by every client of that Project and provider, so a Session whose creator is the anchor is
 * not enough: an earlier or concurrent client created it too. A new task is admitted only where this exact principal,
 * generation included, already has a recorded task, or in the Session this very request just created. Once that record
 * is pruned the Session is refused rather than guessed at. Reading or stopping an existing task needs only its creator
 * edge here, because `isDelegationOwner` already holds the caller to its own tasks.
 */
function authorizeExternalSession(
    database: CaxriDatabase,
    principal: Extract<Principal, { kind: 'delegation-client' }>,
    session: NonNullable<ReturnType<CaxriDatabase['getSession']>>,
    input: Pick<AgentDelegationCreate, 'projectId' | 'sessionId'>,
    access: DelegationAccess,
    isNewSession: boolean,
): void {
    if (principal.projectIds[0] === input.projectId && principal.sessionId === input.sessionId)
        return;
    const isCreated = session.createdBySessionId === principal.sessionId;
    if (access === 'existing' && isCreated) return;
    const project = database
        .listVisibleProjects()
        .find((candidate) => candidate.id === input.projectId);
    if (
        isCreated &&
        project &&
        isTopLevelProject(project) &&
        session.archivedAt === undefined &&
        (isNewSession ||
            database.agentDelegations
                .principalsForSession(input.sessionId)
                .some((recorded) => isSamePrincipal(recorded, principal)))
    )
        return;
    throw new CaxriError(
        'FORBIDDEN',
        'Delegation must remain in the authorized external Session or a Session it created',
    );
}

/**
 * Admits a caller to a delegation Session. For Caxri Bot, `existing` access skips the create-only limits below, which
 * decide where new work may go: the task's owner was proven when it was created and `owned` re-checks the caller
 * Terminal, so archiving the Session or hiding its Project must not cut Caxri Bot off from a result it is still waiting
 * for. Any other Agent is held to its own tasks the same way, so `existing` access admits it to a task in any Session.
 *
 * `isNewSession` marks the Session `admitDelegationRequest` just created for this request, before any task records that
 * the caller owns work there.
 */
export function authorizeDelegationSession(
    database: CaxriDatabase,
    authority: DelegationAuthority,
    input: Pick<AgentDelegationCreate, 'projectId' | 'sessionId'>,
    access: DelegationAccess = 'create',
    isNewSession = false,
): void {
    const session = database.getSession(input.sessionId);
    if (!session || session.projectId !== input.projectId)
        throw new CaxriError('NOT_FOUND', 'Delegation Session is unavailable');
    if (authority.principal.kind === 'human-cli' || authority.principal.kind === 'desktop') return;
    if (isCaxriBotCaller(database, authority)) {
        if (access === 'existing') return;
        /**
         * Only Sessions Caxri Bot created itself, in a Project the user can still see: delegating into a busy user
         * Session would split its active pane, and Caxri Bot never widens into control or dispatch.
         */
        const project = database
            .listVisibleProjects()
            .find((candidate) => candidate.id === input.projectId);
        if (
            !project ||
            !isTopLevelProject(project) ||
            session.archivedAt !== undefined ||
            !database.caxriBotRows()?.sessionIds.includes(input.sessionId)
        )
            throw new CaxriError(
                'FORBIDDEN',
                'Caxri Bot may delegate only into Sessions it created',
            );
        return;
    }
    if (authority.principal.kind === 'delegation-client') {
        authorizeExternalSession(
            database,
            authority.principal,
            session,
            input,
            access,
            isNewSession,
        );
        return;
    }
    if (authority.principal.kind !== 'agent')
        throw new CaxriError('FORBIDDEN', 'Delegation requires an authorized Agent or owner');
    const caller = authority.callerTerminalId && database.getTerminal(authority.callerTerminalId);
    if (!caller) throw new CaxriError('FORBIDDEN', 'Delegation requires an authorized Agent');
    if (access === 'existing' || caller.sessionId === input.sessionId) return;
    /**
     * Outside its own Session, an Agent may start work only in a Session it created for a task: the one this request
     * just created, one an Agent of its Session created, or one where it already delegated. Caxri Bot's Session is
     * excluded from the creator rule: what Caxri Bot created is governed by its current membership, so a Session the
     * user took back stays out of reach of any other Terminal there. Delegating into a user's busy Session would fill
     * its pane, so every other Session is refused, and only in a Project the user can still see.
     */
    const project = database
        .listVisibleProjects()
        .find((candidate) => candidate.id === input.projectId);
    const isCallerSession =
        isNewSession ||
        (session.createdBySessionId === caller.sessionId &&
            caller.sessionId !== database.caxriBotRows()?.sessionId) ||
        database.agentDelegations
            .receiptsForSessions([input.sessionId])
            .some((receipt) => receipt.callerTerminalId === caller.id);
    if (
        !isCallerSession ||
        !project ||
        session.archivedAt !== undefined ||
        !isTopLevelProject(project)
    )
        throw new CaxriError(
            'FORBIDDEN',
            'An Agent may delegate only into its own Session or a Session it created',
        );
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
 * The Agent a type runs on for a caller: the caller's own binding, else the base binding, else the type's default
 * provider with its native model and effort. Each step replaces the whole tuple, so a model never leaks across
 * providers.
 */
function delegationTypeBinding(
    settings: AgentDelegationSettings,
    type: DelegationType,
    caller: DelegationSelection['provider'] | undefined,
): Pick<DelegationSelection, 'effort' | 'model' | 'provider'> {
    const bound = (caller && settings.callers[caller]?.types?.[type]) ?? settings.types[type];
    if (!bound) return { provider: defaultDelegationTypeProvider(type, caller) };
    return {
        provider: bound.provider,
        ...(bound.model && { model: bound.model }),
        ...(bound.effort && { effort: bound.effort }),
    };
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
        types: DELEGATION_TYPES.map((type) => ({
            type,
            ...delegationTypeBinding(settings, type, caller),
        })),
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
    /**
     * Inputs of the child's surface; see `resolveChildSurface`.
     */
    hasAgentChat?(): boolean;
    opensAgentsInChat?(): boolean;
    /**
     * The turn an Agent Chat caller is in, recorded on the task; see `AgentDelegationServiceOptions.callerTurnId`.
     */
    callerTurnId?(terminalId: string): string | undefined;
    /**
     * A retry keeps the failed task's place in the delegation tree instead of reading the caller's live launch and
     * turn, which describe whatever the Agent is doing now.
     */
    inherited?: Pick<AgentDelegationReceipt, 'depth' | 'parentDelegationId'> & {
        callerTurnId?: string;
        callerLaunchId?: string;
    };
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
            (input.type && input.type !== selection.type) ||
            (input.model && input.model !== selection.model) ||
            (input.effort && input.effort !== selection.effort)
        )
            throw new CaxriError(
                'FORBIDDEN',
                'Follow-up must preserve its original delegation selection',
            );
        instructions = previous.frozenInstructions;
    } else if (input.type) {
        selection = {
            ...(input.provider
                ? { provider: input.provider, model: input.model, effort: input.effort }
                : delegationTypeBinding(settings, input.type, caller)),
            type: input.type,
        };
        instructions = DELEGATION_TYPE_INSTRUCTIONS[input.type];
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
        previous || (!input.preset && !input.type && !input.model && !input.effort)
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
    const { inherited } = options;
    const depth = inherited
        ? (inherited.depth ?? 1)
        : (previous?.receipt.depth ?? (parent ? (parent.receipt.depth ?? 1) + 1 : 1));
    if (depth > settings.maxDepth)
        throw new CaxriError('FORBIDDEN', 'Delegation exceeds the configured maximum depth');
    return {
        selection,
        frozenLaunch,
        frozenInstructions: instructions,
        surface: previous
            ? previous.receipt.surface
            : input.continueFromHandover
              ? undefined
              : resolveChildSurface(options, selection.provider, input.surface),
        depth,
        parentDelegationId: inherited
            ? inherited.parentDelegationId
            : (previous?.receipt.parentDelegationId ?? parent?.receipt.delegationId),
        callerTurnId: inherited
            ? inherited.callerTurnId
            : authority.callerTerminalId && options.callerTurnId?.(authority.callerTerminalId),
        callerLaunchId: inherited ? inherited.callerLaunchId : (callerLaunch ?? undefined),
    };
}

/**
 * The digest that makes a request ID name one task. `projectPath` is the folder the original request named instead of a
 * Project ID: the stored input only holds the Project it resolved to, so without it in the digest a replay naming
 * another folder would pass as the same request. Only the digest is stored, never the path.
 */
export function delegationFingerprint(
    authority: DelegationAuthority,
    input: AgentDelegationCreate,
    projectPath?: string,
): string {
    return createHash('sha256')
        .update(
            JSON.stringify(
                projectPath === undefined
                    ? { authority, input }
                    : { authority, input, projectPath },
            ),
        )
        .digest('hex');
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
    /**
     * The failed task this one retries; see `agentDelegationReceiptSchema`.
     */
    retryOf?: string;
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
            ...(options.retryOf && { retryOf: options.retryOf }),
            provider,
            selection: admission.selection,
            ...(admission.surface && { surface: admission.surface }),
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
        ...(admission.callerTurnId && { callerTurnId: admission.callerTurnId }),
        ...(admission.callerLaunchId && { callerLaunchId: admission.callerLaunchId }),
    };
}
