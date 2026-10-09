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
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useDialogStore } from '../../stores/dialogs';
import { useProjects, useSettings } from '../../stores/selectors';
import { newAgentSurface } from '../terminal/new-terminal-agent';
import { ChatSurfaceMarker, OpenInChatSwitch } from './open-in-chat-menu-item';
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
    const openInChat = useSettings()?.['session.openAgentsInChat'];
    const isOpen = Boolean(pendingRoot ?? pendingProjectId);
    // Mirrors the Server's Project-title derivation (`basename(rootPath)` in apps/server/src/domains/db/models/projects.ts) so
    // the dialog previews the same title the created Project will get.
    const contextLabel = pendingRoot
        ? pathBasename(pendingRoot)
        : projects?.find((project) => project.id === pendingProjectId)?.displayTitle;
    const onCancel = cancelPendingSession;
    const onCreate = confirmPendingSession;
    return (
        <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
            <DialogContent className="w-80">
                <DialogHeader>
                    <DialogTitle>Choose the default Terminal</DialogTitle>
                    <DialogDescription>
                        Create a Session{contextLabel ? ` in ${contextLabel}` : ''}. Its primary
                        Agent Terminal provides the Session title when metadata is available.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-1 p-2">
                    {terminalKindSchema.options.map((kind) => (
                        <Button
                            key={kind}
                            className="justify-start"
                            variant="secondary"
                            onClick={() => onCreate(kind)}
                        >
                            <AgentIdentityIcon identity={kind} size={15} />
                            <span className="flex-1 text-left">{resolveAgentIcon(kind).label}</span>
                            {newAgentSurface(kind, openInChat) === 'chat' && <ChatSurfaceMarker />}
                        </Button>
                    ))}
                    {/**
                     * Deliberately quieter than the Terminal choices above: skipping the Terminal is an escape hatch, not a peer of the
                     * real options.
                     */}
                    <Button
                        className="justify-start text-muted"
                        variant="ghost"
                        onClick={() => onCreate(null)}
                    >
                        <SquareDashed size={15} /> Start without a Terminal
                    </Button>
                    <OpenInChatSwitch />
                </div>
            </DialogContent>
        </Dialog>
    );
}
