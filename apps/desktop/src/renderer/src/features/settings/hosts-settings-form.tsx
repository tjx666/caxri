import { useMemo, useState } from 'react';

import type { SshEnvironmentState } from '@caxri/protocol';
import { EllipsisVertical, Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Spinner } from '../../components/ui/spinner';
import { Switch } from '../../components/ui/switch';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { environmentIdOf, useEnvironmentStore } from '../../stores/environment';
import {
    hostDisplayOf,
    listedHostIds,
    setShowHostNames,
    updateHostPreference,
    useHostPreference,
    useHostPreferencesStore,
} from '../../stores/host-preferences';
import { isConnectionSettled } from '../ssh-host/connection-status';
import { HostIconPicker } from '../ssh-host/host-icon-picker';
import {
    connectToSshHost,
    disconnectSshHost,
    openConnectSshHostDialog,
    reconnectSshHost,
    stopSshHostServer,
} from '../ssh-host/ssh-host-commands';

/**
 * Column template shared by the header and every row: Host, Icon, Display Name, Reconnect on Launch, actions.
 */
const HOST_COLUMNS =
    'grid grid-cols-[minmax(9rem,1fr)_11rem_11rem_8.5rem_1.25rem] items-center gap-3';

function ConnectionLabel({ state }: { state: SshEnvironmentState | undefined }) {
    const { t } = useTranslation();
    if (!state || state.phase === 'stopped' || state.phase === 'disconnected')
        return (
            <>
                <span className="size-1.5 rounded-full bg-muted" />
                {t('sshHost.settings.disconnected')}
            </>
        );
    if (isConnectionSettled(state.phase))
        return (
            <>
                <span className="size-1.5 rounded-full bg-danger" />
                <span className="text-danger">{t('sshHost.settings.failed')}</span>
            </>
        );
    if (state.phase !== 'connected')
        return (
            <>
                <Spinner className="size-3" />
                {t('sshHost.settings.reconnecting')}
            </>
        );
    return (
        <>
            <span className="size-1.5 rounded-full bg-success" />
            {t('sshHost.settings.connected')}
        </>
    );
}

/**
 * One machine in Settings › Hosts. The name commits on blur or Enter; an emptied name returns to the destination.
 */
function HostSettingRow({ environmentId }: { environmentId: string | undefined }) {
    const { t } = useTranslation();
    const preference = useHostPreference(environmentId);
    const state = useEnvironmentStore((store) =>
        environmentId === undefined
            ? undefined
            : store.hosts.find((host) => environmentIdOf(host) === environmentId),
    );
    const host = hostDisplayOf(environmentId, preference);
    const [draft, setDraft] = useState<string | undefined>();
    const isLocal = environmentId === undefined;
    const destination = host.destination;
    const commitName = () => {
        if (draft === undefined) return;
        setDraft(undefined);
        if (draft.trim() !== (preference?.name ?? ''))
            void updateHostPreference(environmentId, { name: draft.trim() || null });
    };
    return (
        <div
            className={cn(HOST_COLUMNS, 'rounded-md px-3 py-2 hover:bg-state-hover-quiet')}
            data-testid="host-settings-row"
        >
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                    <span className="truncate">{host.name}</span>
                    {!isLocal && (
                        <span className="inline-flex flex-none items-center gap-1 text-[11px] font-normal text-muted">
                            <ConnectionLabel state={state} />
                        </span>
                    )}
                </span>
                <span className="truncate font-mono text-[11px] text-muted">
                    {isLocal ? t('sshHost.settings.localMachine') : `ssh ${destination}`}
                </span>
            </div>
            <HostIconPicker
                host={host}
                onChange={(icon) => {
                    void updateHostPreference(environmentId, { icon });
                }}
            />
            <Input
                appearance="workbench"
                aria-label={t('sshHost.settings.nameFor', { name: host.name })}
                placeholder={isLocal ? t('sshHost.thisMac') : destination}
                size="dense"
                value={draft ?? preference?.name ?? ''}
                onBlur={commitName}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    else if (event.key === 'Escape') setDraft(undefined);
                }}
            />
            <span className="flex">
                {!isLocal && (
                    <Switch
                        aria-label={t('sshHost.settings.reconnectOnLaunchFor', {
                            name: host.name,
                        })}
                        checked={preference?.reconnectOnLaunch ?? true}
                        onCheckedChange={(checked) => {
                            void updateHostPreference(environmentId, {
                                reconnectOnLaunch: checked,
                            });
                        }}
                    />
                )}
            </span>
            {isLocal ? (
                <span />
            ) : (
                <Menu>
                    <MenuTrigger
                        render={
                            <Button
                                aria-label={t('sshHost.settings.moreFor', { name: host.name })}
                                className="size-5 min-h-0 p-0 text-muted hover:text-foreground"
                                size="icon"
                                variant="ghost"
                            />
                        }
                    >
                        <EllipsisVertical size={12} />
                    </MenuTrigger>
                    <MenuContent align="end">
                        {state ? (
                            <MenuItem
                                onClick={() => {
                                    void reconnectSshHost(environmentId);
                                }}
                            >
                                {t('sshHost.settings.reconnectHost')}
                            </MenuItem>
                        ) : (
                            <MenuItem
                                disabled={destination === undefined}
                                onClick={() => {
                                    if (destination !== undefined)
                                        void connectToSshHost(destination);
                                }}
                            >
                                {t('sshHost.settings.connectHost')}
                            </MenuItem>
                        )}
                        <MenuItem
                            disabled={state?.phase !== 'connected'}
                            onClick={() => {
                                void stopSshHostServer(environmentId);
                            }}
                        >
                            {t('sshHost.status.stopServer')}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                            disabled={!state}
                            onClick={() => {
                                void disconnectSshHost(environmentId);
                            }}
                        >
                            {t('sshHost.disconnect')}
                        </MenuItem>
                    </MenuContent>
                </Menu>
            )}
        </div>
    );
}

/**
 * Settings › Hosts: every machine this window reaches, with its display name, icon, connection, and whether it
 * reconnects on launch. Changes are this Mac's own and apply at once (Desktop Main stores them).
 */
export function HostsSettingsForm() {
    const { t } = useTranslation();
    const hosts = useEnvironmentStore((store) => store.hosts);
    const preferences = useHostPreferencesStore((store) => store);
    const ids = useMemo(() => listedHostIds(hosts, preferences), [hosts, preferences]);
    return (
        <div className="flex flex-col" data-testid="hosts-settings">
            <div className="flex justify-end pb-1">
                <Button size="sm" variant="secondary" onClick={openConnectSshHostDialog}>
                    <Plus size={14} />
                    {t('sshHost.settings.connect')}
                </Button>
            </div>
            <div
                className={cn(
                    HOST_COLUMNS,
                    'px-3 pt-1 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase',
                )}
            >
                <span>{t('sshHost.settings.column.host')}</span>
                <span>{t('sshHost.settings.column.icon')}</span>
                <span>{t('sshHost.settings.column.name')}</span>
                <span className="truncate">{t('sshHost.settings.column.reconnectOnLaunch')}</span>
                <span />
            </div>
            <HostSettingRow environmentId={undefined} />
            {ids.map((id) => (
                <HostSettingRow key={id} environmentId={id} />
            ))}
        </div>
    );
}

/**
 * Settings › Hosts › Show Host Names Next to Icons.
 */
export function ShowHostNamesSwitch({ id, label }: { id: string; label: string }) {
    const shouldShowHostNames = useHostPreferencesStore((store) => store.shouldShowHostNames);
    return (
        <Switch
            aria-label={label}
            checked={shouldShowHostNames}
            className="mt-0.5"
            id={id}
            onCheckedChange={(checked) => {
                void setShowHostNames(checked);
            }}
        />
    );
}
