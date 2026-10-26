import { useState } from 'react';

import type { TerminalKind } from '@caxri/protocol';
import { terminalKindSchema } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { SquareDashed } from 'lucide-react';

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
import { useDialogStore } from '../../stores/dialogs';
import { useProjects, useSettings } from '../../stores/selectors';
import { useAgentAvailability } from '../terminal/hooks/use-agent-availability';
import { agentInstallHint, newAgentSurface } from '../terminal/new-terminal-agent';
import { setDefaultAgent, shouldMakeDefault } from './default-agent-preference';
import { AgentChoiceMarker, OpenInChatSwitch } from './open-in-chat-menu-item';
import { cancelPendingSession, confirmPendingSession } from './session-creation-commands';

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
    const isOpen = Boolean(pendingRoot ?? pendingProjectId);
    // Mirrors the Server's Project-title derivation (`basename(rootPath)` in apps/server/src/domains/db/models/projects.ts) so
    // the dialog previews the same title the created Project will get.
    const contextLabel = pendingRoot
        ? pathBasename(pendingRoot)
        : projects?.find((project) => project.id === pendingProjectId)?.displayTitle;
    return (
        <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && cancelPendingSession()}>
            <DialogContent className="w-80">
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
 * The Agent list and its footer. It mounts with the open dialog, so availability is read only then and the "Always use
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
        <div className="flex flex-col gap-1 p-2">
            {terminalKindSchema.options.map((kind) => {
                const isUnavailable = unavailable.has(kind);
                const hint = isUnavailable ? agentInstallHint(kind, t) : undefined;
                /**
                 * Always wrapped: swapping a bare button for a Tooltip when availability resolves would remount it and
                 * drop the keyboard focus the dialog just placed on the first Agent.
                 */
                return (
                    <Tooltip key={kind} content={hint} disabled={!hint} side="right">
                        <Button
                            className="justify-start"
                            variant="secondary"
                            onClick={() => choose(kind)}
                        >
                            <AgentIdentityIcon identity={kind} size={15} />
                            <span className="flex-1 text-left">{resolveAgentIcon(kind).label}</span>
                            <AgentChoiceMarker
                                isDefault={false}
                                isUnavailable={isUnavailable}
                                surface={newAgentSurface(kind, openInChat)}
                            />
                        </Button>
                    </Tooltip>
                );
            })}
            <p className="m-0 px-1 py-1 text-[12px] leading-4 text-muted">
                {t('session.createDialog.fullAccessNotice')}
            </p>
            {/**
             * Deliberately quieter than the Terminal choices above: skipping the Terminal is an escape hatch, not a peer of the
             * real options.
             */}
            <Button
                className="justify-start text-muted"
                variant="ghost"
                onClick={() => choose(null)}
            >
                <SquareDashed size={15} /> {t('session.create.withoutTerminal')}
            </Button>
            <label className="flex cursor-pointer items-center justify-between gap-2 px-1 text-[12px] text-muted">
                {t('session.createDialog.alwaysUseAgent')}
                <Switch checked={isDefaultRequested} onCheckedChange={setDefaultRequested} />
            </label>
            <OpenInChatSwitch />
        </div>
    );
}
