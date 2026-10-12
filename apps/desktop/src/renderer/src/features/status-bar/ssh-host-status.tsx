import { Server } from 'lucide-react';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { useTranslation } from '../../i18n';
import { useSshEnvironment } from '../../stores/environment';
import { StatusInfo } from './status-info';

/**
 * Names the SSH Host an SSH Host window runs on, at the start of the status bar the way VS Code's remote indicator
 * does. Absent in a local window, which is the default and says nothing.
 */
export function SshHostStatus() {
    const { t } = useTranslation();
    const environment = useSshEnvironment();
    if (!environment) return null;
    const { destination, platform } = environment;
    return (
        <StatusInfo
            focusable
            ariaLabel={t('sshHost.status.ariaLabel', { destination })}
            className="ssh-host-status"
            icon={<Server />}
            title={
                <StructuredTooltip
                    title={t('sshHost.status.tooltip', { destination })}
                    notes={platform ? [t('sshHost.status.platform', platform)] : []}
                />
            }
        >
            {t('sshHost.windowTitle', { destination })}
        </StatusInfo>
    );
}
