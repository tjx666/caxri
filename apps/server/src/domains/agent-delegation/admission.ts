import type {
    AgentDelegationCreate,
    AgentDelegationSettings,
    AgentLaunchSettings,
    AgentProvider,
    DelegationRoster,
    DelegationSelection,
    Principal,
} from '@caxri/protocol';
import { CaxriError, delegationProviderSchema, isDelegationEffortSupported } from '@caxri/protocol';

import { delegationAdapter } from '../agents';
import type { CaxriDatabase, StoredAgentDelegation } from '../db';
import { validateDelegationLaunch } from './launch';

export interface DelegationAuthority {
    principal: Principal;
    callerTerminalId?: string;
}

export function authorizeDelegationSession(
    database: CaxriDatabase,
    authority: DelegationAuthority,
    input: Pick<AgentDelegationCreate, 'projectId' | 'sessionId'>,
): void {
    const session = database.getSession(input.sessionId);
    if (!session || session.projectId !== input.projectId)
        throw new CaxriError('NOT_FOUND', 'Delegation Session is unavailable');
    if (authority.principal.kind === 'human-cli' || authority.principal.kind === 'desktop') return;
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
    return {
        maxDepth: settings.maxDepth,
        prepend: binding?.prepend,
        append: binding?.append,
        presets: settings.presets
            .filter((preset) => !binding?.exclude?.includes(preset.name))
            .map((preset) => {
                const overrides = binding?.presets;
                const override =
                    overrides && Object.hasOwn(overrides, preset.name)
                        ? overrides[preset.name]
                        : undefined;
                return {
                    name: preset.name,
                    provider: override?.provider ?? preset.provider,
                    model: override ? override.model : preset.model,
                    effort: override ? override.effort : preset.effort,
                    useWhen: override?.useWhen ?? preset.useWhen,
                    dontUseWhen: override?.dontUseWhen ?? preset.dontUseWhen,
                };
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
