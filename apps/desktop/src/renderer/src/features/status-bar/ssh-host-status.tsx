import { Server } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { StructuredTooltip } from '../../components/structured-tooltip';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSshEnvironment } from '../../stores/environment';
import { canReconnect } from '../ssh-host/connection-status';
import { statusItemClassName } from './status-item';

/**
 * Names the SSH Host an SSH Host window runs on, at the start of the status bar the way VS Code's remote indicator
 * does, and opens the window's SSH Host actions the way that indicator's menu does. Absent in a local window, which is
 * the default and says nothing.
 */
export function SshHostStatus() {
    const { t } = useTranslation();
    const environment = useSshEnvironment();
    if (!environment) return null;
    const { destination, platform } = environment;
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
                    <Server />
                    <span>{t('sshHost.windowTitle', { destination })}</span>
                </MenuTrigger>
            </Tooltip>
            <MenuContent side="top">
                {/* The connection overlay covers this bar until the window is connected, so Reconnect rarely applies. */}
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
                <MenuItem onClick={() => window.close()}>{t('sshHost.closeWindow')}</MenuItem>
            </MenuContent>
        </Menu>
    );
}
