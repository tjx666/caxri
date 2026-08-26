import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
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
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useDialogStore } from '../../stores/dialogs';
import { useProjects } from '../../stores/selectors';
import { cancelPendingSession, confirmPendingSession } from './session-actions';

export function CreateSessionDialog() {
    const pendingRoot = useDialogStore((state) => state.pendingRoot);
    const pendingProjectId = useDialogStore((state) => state.pendingProjectId);
    const projects = useProjects();
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Choose the default Terminal</DialogTitle>
                    <DialogDescription>
                        Create a Session{contextLabel ? ` in ${contextLabel}` : ''}. Its primary
                        Agent Terminal provides the Session title when metadata is available.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-3 gap-2 p-4">
                    {agentProviderIds.map((provider) => (
                        <Button
                            key={provider}
                            variant="secondary"
                            onClick={() => onCreate(provider)}
                        >
                            <AgentIdentityIcon identity={provider} size={15} />{' '}
                            {agentProviderCatalog[provider].displayName}
                        </Button>
                    ))}
                    <Button variant="secondary" onClick={() => onCreate('shell')}>
                        <AgentIdentityIcon identity="shell" size={15} /> Shell
                    </Button>
                    {/**
                     * Deliberately quieter than the primary grid: skipping the Terminal is an escape hatch, not a peer of the three real
                     * choices.
                     */}
                    <Button
                        variant="ghost"
                        className="col-span-3 text-muted"
                        onClick={() => onCreate(null)}
                    >
                        <SquareDashed size={15} /> Start without a Terminal
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
