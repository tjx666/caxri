import type { KeyboardEvent } from 'react';
import { useState } from 'react';

import type { TerminalKind } from '@caxri/protocol';
import { agentProviderSchema, terminalKindSchema } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { Settings2, ShieldAlert, SquareDashed } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { Switch } from '../../components/ui/switch';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { useDialogStore } from '../../stores/dialogs';
import { useProjects, useSettings } from '../../stores/selectors';
import { useAgentAvailability } from '../terminal/hooks/use-agent-availability';
import { agentInstallHint, newAgentSurface } from '../terminal/new-terminal-agent';
import { setDefaultAgent, shouldMakeDefault } from './default-agent-preference';
import { AgentChoiceMarker, OpenInChatSwitch } from './open-in-chat-menu-item';
import {
    cancelPendingSession,
    configurePendingAgent,
    confirmPendingSession,
} from './session-creation-commands';

/**
 * Centered fallback for the one Terminal choice that has nothing to anchor to: adding a Project starts at the native
 * folder picker, which leaves no on-screen trigger behind. Every other entry point uses the Project row's anchored
 * `CreateSessionMenu`; both render the protocol catalog in its declaration order so the two surfaces cannot disagree.
 */
export function CreateSessionDialog() {
    const pendingRoot = useDialogStore((state) => state.pendingRoot);
    const pendingProjectId = useDialogStore((state) => state.pendingProjectId);
    const projects = useProjects();
    const { t } = useTranslation();
    const isSuspended = useDialogStore((state) => state.isPendingSuspended);
    // Hidden, not dismissed, while the user configures an Agent in Settings: the pending Project stays.
    const isOpen = Boolean(pendingRoot ?? pendingProjectId) && !isSuspended;
    // Mirrors the Server's Project-title derivation (`basename(rootPath)` in apps/server/src/domains/db/models/projects.ts) so
    // the dialog previews the same title the created Project will get.
    const contextLabel = pendingRoot
        ? pathBasename(pendingRoot)
        : projects?.find((project) => project.id === pendingProjectId)?.title;
    return (
        <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && cancelPendingSession()}>
            <DialogContent className="w-[min(480px,calc(100vw-32px))]">
                <DialogHeader>
                    <DialogTitle>
                        {contextLabel
                            ? t('session.createDialog.titleInProject', { project: contextLabel })
                            : t('session.createDialog.title')}
                    </DialogTitle>
                    <DialogDescription>{t('session.createDialog.description')}</DialogDescription>
                </DialogHeader>
                <CreateSessionChoices />
            </DialogContent>
        </Dialog>
    );
}

/**
 * Moves focus between the Agent tiles with the arrow keys, wrapping at both ends, so the row reads as one dock-like
 * control rather than a run of separate Tab stops the user has to count through.
 */
function moveTileFocus(event: KeyboardEvent<HTMLDivElement>): void {
    const step = { ArrowLeft: -1, ArrowRight: 1, End: Infinity, Home: -Infinity }[event.key];
    if (step === undefined) return;
    const tiles = [
        ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-agent-tile]'),
    ];
    const current = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) return;
    event.preventDefault();
    const next = Number.isFinite(step)
        ? (current + step + tiles.length) % tiles.length
        : step > 0
          ? tiles.length - 1
          : 0;
    tiles[next]?.focus();
}

/**
 * The Agent tiles and the footer. It mounts with the open dialog, so availability is read only then and the "Always use
 * this Agent" switch starts off for every visit: it is a choice for this pick, not a saved preference until an Agent is
 * chosen.
 */
function CreateSessionChoices() {
    const settings = useSettings();
    const openInChat = settings?.['session.openAgentsInChat'];
    const currentDefault = settings?.['session.defaultAgent'];
    const { t } = useTranslation();
    const unavailable = useAgentAvailability();
    const [isDefaultRequested, setDefaultRequested] = useState(false);
    const choose = (kind: TerminalKind | null): void => {
        if (shouldMakeDefault(isDefaultRequested, kind, currentDefault)) setDefaultAgent(kind);
        confirmPendingSession(kind);
    };
    return (
        <div className="flex flex-col gap-3 p-4">
            <div
                className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl border border-border bg-background p-2"
                onKeyDown={moveTileFocus}
            >
                {terminalKindSchema.options.map((kind) => {
                    const isUnavailable = unavailable.has(kind);
                    const hint = isUnavailable ? agentInstallHint(kind, t) : undefined;
                    const provider = agentProviderSchema.safeParse(kind);
                    const configureLabel = t('session.createDialog.configureAgent', {
                        agent: resolveAgentIcon(kind).label,
                    });
                    /**
                     * Always wrapped: swapping a bare button for a Tooltip when availability resolves would remount it
                     * and drop the keyboard focus the dialog just placed on the first Agent.
                     */
                    return (
                        <div key={kind} className="relative flex flex-col">
                            <Tooltip content={hint} disabled={!hint} side="bottom">
                                <button
                                    data-agent-tile=""
                                    className="group flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border-0 bg-transparent px-1 pt-3 pb-2 text-foreground outline-none hover:bg-state-hover"
                                    type="button"
                                    onClick={() => choose(kind)}
                                >
                                    {/**
                                     * The icon well lifts on hover like a Dock icon; an Agent that is not installed stays pickable (the tooltip says how to
                                     * install it) but its glyph recedes.
                                     */}
                                    <span
                                        className={cn(
                                            'mb-1 grid size-14 place-items-center rounded-xl border border-border bg-elevated shadow-[0_2px_8px_var(--shadow)] transition-[translate,scale,border-color,box-shadow] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:scale-105 group-focus-visible:border-accent group-focus-visible:shadow-[0_0_0_3px_var(--state-focus-ring)] motion-reduce:transition-none',
                                            isUnavailable && 'opacity-50 grayscale',
                                        )}
                                    >
                                        <AgentIdentityIcon identity={kind} size={30} />
                                    </span>
                                    <span className="text-[13px] leading-4 font-medium">
                                        {resolveAgentIcon(kind).label}
                                    </span>
                                    {/* Reserved so tiles with and without a marker keep their labels on one baseline. */}
                                    <span className="h-4 text-[11px] leading-4 whitespace-nowrap">
                                        <AgentChoiceMarker
                                            isDefault={false}
                                            isUnavailable={isUnavailable}
                                            surface={newAgentSurface(kind, openInChat)}
                                        />
                                    </span>
                                </button>
                            </Tooltip>
                            {provider.success && isUnavailable && (
                                <Tooltip content={configureLabel} side="top">
                                    <button
                                        aria-label={configureLabel}
                                        className="absolute top-1 right-1 grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted outline-none hover:bg-state-hover hover:text-foreground focus-visible:shadow-[0_0_0_3px_var(--state-focus-ring)]"
                                        type="button"
                                        onClick={() => configurePendingAgent(provider.data)}
                                    >
                                        <Settings2 aria-hidden="true" size={14} />
                                    </button>
                                </Tooltip>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="flex items-start gap-2 px-1 text-[12px] leading-4 text-muted">
                <ShieldAlert aria-hidden="true" className="mt-px flex-none" size={14} />
                <p className="m-0">{t('session.createDialog.fullAccessNotice')}</p>
            </div>
            <div className="-mx-4 -mb-4 flex flex-col gap-2 border-t border-border px-4 pt-3 pb-3">
                <label className="flex cursor-pointer items-center justify-between gap-2 px-1 text-[12px] text-muted">
                    {t('session.createDialog.alwaysUseAgent')}
                    <Switch checked={isDefaultRequested} onCheckedChange={setDefaultRequested} />
                </label>
                <OpenInChatSwitch />
                {/**
                 * Deliberately quieter than the Agent tiles above: skipping the Terminal is an escape hatch, not a peer of the real
                 * options.
                 */}
                <Button
                    className="-ml-1 self-start text-muted"
                    size="sm"
                    variant="ghost"
                    onClick={() => choose(null)}
                >
                    <SquareDashed size={14} /> {t('session.create.withoutTerminal')}
                </Button>
            </div>
        </div>
    );
}
