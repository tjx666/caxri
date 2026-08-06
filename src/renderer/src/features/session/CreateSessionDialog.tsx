import { agentProviderCatalog, agentProviderIds } from '@shared/agents';

import { AgentIdentityIcon } from '../../agent-icons/AgentIdentityIcon';
import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { useDialogStore } from '../../state/dialogs';
import { useProjects } from '../../state/selectors';
import { cancelPendingSession, confirmPendingSession } from './session-actions';

export function CreateSessionDialog() {
    const pendingRoot = useDialogStore((state) => state.pendingRoot);
    const pendingProjectId = useDialogStore((state) => state.pendingProjectId);
    const projects = useProjects();
    const open = Boolean(pendingRoot || pendingProjectId);
    const contextLabel =
        pendingRoot ?? projects?.find((project) => project.id === pendingProjectId)?.displayTitle;
    const onCancel = cancelPendingSession;
    const onCreate = confirmPendingSession;
    return (
        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
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
                </div>
            </DialogContent>
        </Dialog>
    );
}
