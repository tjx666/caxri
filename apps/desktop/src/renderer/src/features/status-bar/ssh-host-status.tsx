import { executeCommand } from '../../commands/execute';
import { StructuredTooltip } from '../../components/structured-tooltip';
import {
    Menu,
    MenuCheckboxItem,
    MenuContent,
    MenuItem,
    MenuSeparator,
    MenuTrigger,
} from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { openSettings } from '../../stores/dialogs';
import { environmentIdOf, useSshEnvironment } from '../../stores/environment';
import {
    hostDisplayOf,
    updateHostPreference,
    useHostPreference,
} from '../../stores/host-preferences';
import { canReconnect } from '../ssh-host/connection-status';
import { HostGlyph } from '../ssh-host/host-glyph';
import { disconnectSshHost } from '../ssh-host/ssh-host-commands';
import { statusItemClassName } from './status-item';

/**
 * Names the SSH Host the selected Session runs on, at the start of the status bar the way VS Code's remote indicator
 * does, and opens that Host's actions the way that indicator's menu does. Absent for a Session on this Mac, which is
 * the default and says nothing.
 */
export function SshHostStatus() {
    const { t } = useTranslation();
    const environment = useSshEnvironment();
    const environmentId = environment && environmentIdOf(environment);
    const preference = useHostPreference(environmentId);
    if (!environment || environmentId === undefined) return null;
    const { destination, platform } = environment;
    const host = hostDisplayOf(environmentId, preference);
    return (
        <Menu>
            <Tooltip
                content={
                    <StructuredTooltip
                        title={t('sshHost.status.tooltip', { destination })}
                        notes={
                            platform
                                ? [
                                      t(
                                          platform.system === 'macos'
                                              ? 'sshHost.status.platformMacos'
                                              : 'sshHost.status.platformLinux',
                                          platform,
                                      ),
                                  ]
                                : []
                        }
                    />
                }
            >
                <MenuTrigger
                    render={
                        <button
                            aria-label={t('sshHost.status.ariaLabel', { destination })}
                            className={cn(statusItemClassName, 'ssh-host-status flex-none')}
                            type="button"
                        />
                    }
                >
                    <HostGlyph icon={host.icon} size={13} system={host.system} />
                    <span>{t('sshHost.windowTitle', { destination: host.name })}</span>
                </MenuTrigger>
            </Tooltip>
            <MenuContent side="top">
                {/* The connection card offers Reconnect too; this keeps it reachable after the card scrolls away. */}
                {canReconnect(environment) && (
                    <MenuItem onClick={() => executeCommand('sshHost.reconnect')}>
                        {t('sshHost.reconnect')}
                    </MenuItem>
                )}
                <MenuItem onClick={() => executeCommand('sshHost.stopServer')}>
                    {t('sshHost.status.stopServer')}
                </MenuItem>
                <MenuItem onClick={() => executeCommand('sshHost.connect')}>
                    {t('commands.sshHost.connect')}
                </MenuItem>
                <MenuSeparator />
                <MenuCheckboxItem
                    checked={preference?.reconnectOnLaunch ?? true}
                    onCheckedChange={(checked) => {
                        void updateHostPreference(environmentId, { reconnectOnLaunch: checked });
                    }}
                >
                    {t('sshHost.status.reconnectOnLaunch')}
                </MenuCheckboxItem>
                <MenuItem
                    // eslint-disable-next-line no-void -- disconnectSshHost reports its own failure through a toast
                    onClick={() => void disconnectSshHost(environmentId)}
                >
                    {t('sshHost.status.disconnect', { destination: host.name })}
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => openSettings('hosts')}>
                    {t('sshHost.status.manageHosts')}
                </MenuItem>
            </MenuContent>
        </Menu>
    );
}
