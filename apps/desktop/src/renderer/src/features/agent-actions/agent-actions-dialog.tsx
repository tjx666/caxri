import type { KeyboardEvent } from 'react';
import { useId, useMemo, useRef, useState } from 'react';

import type {
    AgentAction,
    AgentActionRecentSettings,
    AgentActionsSettings,
    AgentProvider,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    mergeAgentActions,
    resolveRecentAgentActions,
} from '@caxri/protocol';
import { Settings2 } from 'lucide-react';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { isAgentProcessRunning } from '../../lib/terminal-agent-runtime';
import { useCaxriQuery } from '../../queries/client';
import { setAgentActionsOpen, useDialogStore } from '../../stores/dialogs';
import { getBootstrap, useSessions, useSettings, useTerminal } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { focusTerminalById } from '../terminal/terminal-commands';
import type { AgentActionSubmitMode } from './agent-action-input';
import {
    agentActionSubmitModes,
    agentActionTerminalInputSteps,
    canExecuteAgentAction,
    isAlternateAgentActionChord,
} from './agent-action-input';
import { searchAgentActions } from './agent-action-search';
import { describeAgentActionTarget, resolveAgentActionTargetTitle } from './agent-action-target';
import { didSendAgentActionInputSteps, recordRecentAgentAction } from './agent-actions-commands';

const sourceLabels: Record<AgentAction['source'], string> = {
    builtIn: 'Built-in',
    project: 'Project',
    global: 'User',
    legacy: 'Legacy',
    custom: 'Custom',
};

interface AgentActionRowProperties {
    action: AgentAction;
    location: 'catalog' | 'recent';
    onSelect: (action: AgentAction) => void;
}

function AgentActionRow({ action, location, onSelect }: AgentActionRowProperties) {
    return (
        <CommandItem
            data-agent-action={action.invocation}
            value={`${location}:${action.invocation}`}
            onSelect={() => onSelect(action)}
        >
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                    <code className="font-mono text-[12px] text-foreground">
                        {action.invocation}
                    </code>
                    {action.argumentHint && (
                        <span className="truncate font-mono text-[11px] text-muted">
                            {action.argumentHint}
                        </span>
                    )}
                </span>
                {action.description && (
                    <span className="truncate text-[11px] text-muted">{action.description}</span>
                )}
            </span>
            <small className="shrink-0 text-[10px] text-muted">{sourceLabels[action.source]}</small>
        </CommandItem>
    );
}

/**
 * The recents to render. `recordRecent` returns the list the Server just persisted, which arrives before the settings
 * push that carries it, so an override wins over `actionSettings`, but only for the provider it was recorded against,
 * since switching Terminals can change the provider before that push lands.
 */
function visibleRecentActions(
    actions: readonly AgentAction[],
    actionSettings: AgentActionsSettings | undefined,
    provider: AgentProvider | undefined,
    override: { provider: AgentProvider; recent: AgentActionRecentSettings } | undefined,
): AgentAction[] {
    if (!actionSettings) return [];
    return resolveRecentAgentActions(actions, {
        ...actionSettings,
        recent:
            override && override.provider === provider ? override.recent : actionSettings.recent,
    });
}

/**
 * The dialog's target line: which Agent is about to receive the action, and which Session or Terminal it belongs to.
 * Its own component so the branch between a shared title and a Session/Terminal pair stays out of the picker's control
 * flow; the picker only decides _what_ to submit, never how the target is described.
 */
function AgentActionTargetNote({
    id,
    provider,
    sessionTitle,
    terminalTitle,
}: {
    id: string;
    provider: AgentProvider | undefined;
    sessionTitle: string | undefined;
    terminalTitle: string | undefined;
}) {
    const providerName = provider ? agentProviderCatalog[provider].displayName : 'Agent';
    const targetTitle = resolveAgentActionTargetTitle(sessionTitle, terminalTitle);
    return (
        <div
            id={id}
            aria-label={describeAgentActionTarget(providerName, targetTitle)}
            className="flex items-center gap-2 border-b border-border px-4 py-2 text-[11px] text-muted"
            data-agent-action-target=""
            data-target-title-kind={targetTitle.kind}
            role="note"
        >
            {provider && <AgentIdentityIcon identity={provider} size={14} />}
            <span className="font-medium text-foreground">{providerName}</span>
            <span aria-hidden="true">·</span>
            {targetTitle.kind === 'shared' ? (
                <span className="min-w-0 truncate" data-agent-action-target-title="shared">
                    {targetTitle.title}
                </span>
            ) : (
                <>
                    <span className="min-w-0 truncate" data-agent-action-target-title="session">
                        Session: {targetTitle.sessionTitle}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 truncate" data-agent-action-target-title="terminal">
                        Terminal: {targetTitle.terminalTitle}
                    </span>
                </>
            )}
        </div>
    );
}

export function AgentActionsDialog() {
    const targetDescriptionId = useId();
    const interactionDescriptionId = useId();
    const shouldRestoreTerminalFocusReference = useRef(true);
    const inputSequenceInFlightReference = useRef(false);
    const [search, setSearch] = useState('');
    const [recentOverride, setRecentOverride] = useState<{
        provider: AgentProvider;
        recent: AgentActionRecentSettings;
    }>();
    const isOpen = useDialogStore((state) => state.agentActionsOpen);
    const terminalId = useDialogStore((state) => state.agentActionsTerminalId);
    const settings = useSettings();
    const terminal = useTerminal(terminalId ?? '');
    const sessions = useSessions();
    const session = sessions?.find((candidate) => candidate.id === terminal?.sessionId);
    const provider = terminal?.provider;
    const isAgentRunning = isAgentProcessRunning(terminal?.lastAgentProcessState);
    const query = useCaxriQuery(
        'agentActions.list',
        { terminalId: terminalId ?? '' },
        { enabled: Boolean(isOpen && terminalId && provider && isAgentRunning), staleTime: 0 },
    );
    const fallbackActions = useMemo(
        () =>
            provider && settings
                ? mergeAgentActions(provider, [], settings['agents.providers'][provider].actions)
                : [],
        [provider, settings],
    );
    /**
     * A zero-stale-time refetch can retain the previous result while it runs. Render only the current settings fallback
     * until this open's discovery settles, so a deleted or newly disabled skill never flashes as selectable.
     */
    const actions =
        query.data && !query.isFetching && !query.isError ? query.data.actions : fallbackActions;
    const visibleActionGroups = useMemo(() => {
        const groupedActions = new Map<AgentAction['kind'], AgentAction[]>();
        for (const action of searchAgentActions(actions, search)) {
            const group = groupedActions.get(action.kind);
            if (group) group.push(action);
            else groupedActions.set(action.kind, [action]);
        }
        return [...groupedActions].map(([kind, grouped]) => ({ grouped, kind }));
    }, [actions, search]);
    const actionSettings = provider ? settings?.['agents.providers'][provider].actions : undefined;
    const recentActions = visibleRecentActions(actions, actionSettings, provider, recentOverride);
    const shouldShowRecent = search.trim() === '' && recentActions.length > 0;

    const closePicker = (shouldRestoreTerminalFocus = true): void => {
        shouldRestoreTerminalFocusReference.current = shouldRestoreTerminalFocus;
        setSearch('');
        setAgentActionsOpen(false);
    };

    const submit = (action: AgentAction, mode: AgentActionSubmitMode): void => {
        if (inputSequenceInFlightReference.current) return;
        if (mode === 'run' && !canExecuteAgentAction(action)) {
            pushToast('info', `${action.invocation} needs arguments before it can run.`);
            return;
        }
        const current = getBootstrap()?.terminals.find((candidate) => candidate.id === terminalId);
        if (!current?.provider || !isAgentProcessRunning(current.lastAgentProcessState)) {
            pushToast('error', 'The selected Agent is no longer running.');
            closePicker();
            return;
        }
        const currentProvider = current.provider;
        /**
         * Keep the modal focused until every provider input step is queued. Restoring xterm focus earlier would let a
         * user's keystroke interleave with Codex's invocation and completion keys during the settle window.
         */
        inputSequenceInFlightReference.current = true;
        // eslint-disable-next-line no-void -- each request owns its user-visible failure path
        void (async () => {
            const inputSucceeded = await didSendAgentActionInputSteps(
                current.id,
                agentActionTerminalInputSteps(currentProvider, action, mode),
            );
            inputSequenceInFlightReference.current = false;
            closePicker();
            if (!inputSucceeded) return;
            const recent = await recordRecentAgentAction(current.id, action.invocation);
            if (recent) setRecentOverride({ provider: currentProvider, recent });
        })();
    };

    return (
        <Dialog
            open={isOpen}
            onOpenChange={(open) => {
                if (open) setAgentActionsOpen(true);
                else if (!inputSequenceInFlightReference.current) closePicker();
            }}
        >
            <PickerDialogContent
                data-agent-actions-picker=""
                data-target-terminal-id={terminalId}
                finalFocus={() => {
                    if (terminalId && shouldRestoreTerminalFocusReference.current)
                        focusTerminalById(terminalId);
                    shouldRestoreTerminalFocusReference.current = true;
                    return false;
                }}
            >
                <DialogTitle className="sr-only">Agent Commands &amp; Skills</DialogTitle>
                <AgentActionTargetNote
                    id={targetDescriptionId}
                    provider={provider}
                    sessionTitle={session?.displayTitle}
                    terminalTitle={terminal?.title}
                />
                <Command
                    className="w-full"
                    label="Agent Commands & Skills"
                    shouldFilter={false}
                    onKeyDownCapture={(event: KeyboardEvent<HTMLDivElement>) => {
                        if (!isAlternateAgentActionChord(event)) return;
                        /**
                         * Always consume the alternate insert chord before cmdk can reinterpret it as ordinary Enter. A
                         * missing selection is a no-op, never an accidental insertion.
                         */
                        event.preventDefault();
                        event.stopPropagation();
                        const selectedInvocation = event.currentTarget.querySelector<HTMLElement>(
                            '[cmdk-item][data-selected="true"]',
                        )?.dataset.agentAction;
                        const selectedAction = actions.find(
                            (action) => action.invocation === selectedInvocation,
                        );
                        if (!selectedAction) return;
                        submit(selectedAction, agentActionSubmitModes.alternate);
                    }}
                >
                    <CommandInput
                        autoFocus
                        aria-describedby={`${targetDescriptionId} ${interactionDescriptionId}`}
                        placeholder="Search skills and slash commands…"
                        value={search}
                        onValueChange={setSearch}
                    />
                    <CommandList>
                        <CommandEmpty>No Agent command or skill found.</CommandEmpty>
                        {shouldShowRecent && (
                            <CommandGroup data-agent-action-group="recent" heading="Recently Used">
                                {recentActions.map((action) => (
                                    <AgentActionRow
                                        key={action.invocation}
                                        action={action}
                                        location="recent"
                                        onSelect={(selected) =>
                                            submit(selected, agentActionSubmitModes.primary)
                                        }
                                    />
                                ))}
                            </CommandGroup>
                        )}
                        {visibleActionGroups.map(({ grouped, kind }) => (
                            <CommandGroup
                                key={kind}
                                data-agent-action-group={kind}
                                heading={kind === 'command' ? 'Commands' : 'Skills'}
                            >
                                {grouped.map((action) => (
                                    <AgentActionRow
                                        key={action.invocation}
                                        action={action}
                                        location="catalog"
                                        onSelect={(selected) =>
                                            submit(selected, agentActionSubmitModes.primary)
                                        }
                                    />
                                ))}
                            </CommandGroup>
                        ))}
                        {query.isFetching && (
                            <p className="m-0 px-3 py-2 text-[11px] text-muted" role="status">
                                Discovering skills…
                            </p>
                        )}
                        {(query.isError || query.data?.discovery === 'partial') && (
                            <p className="m-0 px-3 py-2 text-[11px] text-warning" role="status">
                                Some commands or skills were unavailable or exceeded discovery
                                limits. Available commands and skills are still ready.
                            </p>
                        )}
                    </CommandList>
                </Command>
                <span id={interactionDescriptionId} className="sr-only">
                    Enter runs the selected action. Command+Enter inserts it for editing.
                </span>
                <div
                    className="flex min-h-10 items-center justify-between gap-3 border-t border-border px-3 py-1.5"
                    data-agent-action-footer=""
                >
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            closePicker(false);
                            if (provider)
                                useDialogStore.getState().openSettings('agent-actions', provider);
                        }}
                    >
                        <Settings2 size={13} /> Manage in Settings…
                    </Button>
                    <div className="flex items-center gap-3 text-[10px] text-muted">
                        <span className="flex items-center gap-1" data-agent-action-mode="run">
                            <ShortcutBadge compact shortcut="enter" /> Run
                        </span>
                        <span className="flex items-center gap-1" data-agent-action-mode="insert">
                            <ShortcutBadge compact shortcut="cmd+enter" /> Insert
                        </span>
                    </div>
                </div>
            </PickerDialogContent>
        </Dialog>
    );
}
