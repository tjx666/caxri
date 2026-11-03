import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { useTranslation } from '../../i18n';
import { environmentIdOf, useEnvironmentStore } from '../../stores/environment';
import { hostDisplayOf, useHostPreference } from '../../stores/host-preferences';
import { HostGlyph } from './host-glyph';
import { settleProjectMachine, useSshHostDialogsStore } from './ssh-host-dialogs-store';

function MachineChoice({ environmentId }: { environmentId: string | undefined }) {
    const preference = useHostPreference(environmentId);
    const host = hostDisplayOf(environmentId, preference);
    return (
        <button
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-[13px] text-foreground hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
            type="button"
            onClick={() =>
                settleProjectMachine(environmentId === undefined ? {} : { environmentId })
            }
        >
            <span className="text-muted">
                <HostGlyph icon={host.icon} size={14} system={host.system} />
            </span>
            <span className="min-w-0 flex-1 truncate">{host.name}</span>
            {host.destination && host.destination !== host.name && (
                <span className="truncate font-mono text-[11px] text-muted">
                    {host.destination}
                </span>
            )}
        </button>
    );
}

/**
 * Add Project's first step while an SSH Host is connected: which machine the Project goes on. This Mac then opens its
 * native folder dialog, an SSH Host its folder browser.
 */
export function ProjectMachineDialog() {
    const { t } = useTranslation();
    const isOpen = useSshHostDialogsStore((state) => state.resolveMachine !== undefined);
    const hosts = useEnvironmentStore((store) => store.hosts);
    return (
        <Dialog
            open={isOpen}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) settleProjectMachine(undefined);
            }}
        >
            {isOpen && (
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('sshHost.addProject.title')}</DialogTitle>
                        <DialogDescription>{t('sshHost.addProject.description')}</DialogDescription>
                    </DialogHeader>
                    <div className="p-2" data-testid="project-machine-choices">
                        <MachineChoice environmentId={undefined} />
                        {hosts
                            .filter((host) => host.phase === 'connected')
                            .map((host) => (
                                <MachineChoice
                                    key={environmentIdOf(host)}
                                    environmentId={environmentIdOf(host)}
                                />
                            ))}
                    </div>
                </DialogContent>
            )}
        </Dialog>
    );
}
