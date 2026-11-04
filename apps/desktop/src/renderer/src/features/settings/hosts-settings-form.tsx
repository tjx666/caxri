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
import { HostGlyph } from '../ssh-host/host-glyph';
import { HostIconPicker } from '../ssh-host/host-icon-picker';
import {
    connectToSshHost,
    disconnectSshHost,
    openConnectSshHostDialog,
    reconnectSshHost,
    stopSshHostServer,
} from '../ssh-host/ssh-host-commands';

/**
 * One row of the Hosts card. Rows share the card's column template through `subgrid`, so every machine's controls line
 * up without a header row; each control names its column through its own label or placeholder. Every row after the
 * first draws the divider above itself.
 */
const HOST_CARD_ROW =
    'col-span-full grid grid-cols-subgrid items-center gap-x-3 gap-y-2 px-4 py-3 not-first:border-t not-first:border-border';

/**
 * The icon picker and name field. A wide card gives each its own column (`contents` makes them grid items of the row);
 * a narrow one moves the pair to a second line under the name, which would otherwise shrink to a single character.
 */
const HOST_CARD_FIELDS = 'col-[2/-1] row-start-2 grid grid-cols-2 gap-2 @2xl/hosts:contents';

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
function HostSettingRow({
    environmentId,
    hasActionColumns,
}: {
    environmentId: string | undefined;
    /**
     * Whether the card has the reconnect and more-actions columns a remote host fills; the local row then holds both
     * open with blanks so its fields line up with the remote rows' fields.
     */
    hasActionColumns: boolean;
}) {
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
        <div className={HOST_CARD_ROW} data-testid="host-settings-row">
            <span className="flex size-8 items-center justify-center rounded-md bg-elevated text-muted">
                <HostGlyph icon={host.icon} size={16} system={host.system} />
            </span>
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
            <div className={HOST_CARD_FIELDS}>
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
                    value={draft ?? preference?.name ?? ''}
                    onBlur={commitName}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        else if (event.key === 'Escape') setDraft(undefined);
                    }}
                />
            </div>
            {isLocal && hasActionColumns && (
                <>
                    <span />
                    <span className="size-6" />
                </>
            )}
            {!isLocal && (
                <label className="flex items-center gap-2 text-[12px] whitespace-nowrap text-muted">
                    {/* Below the card's full width the caption gives way to the name; the switch keeps its own name. */}
                    <span className="hidden @3xl/hosts:inline">
                        {t('sshHost.settings.reconnectOnLaunch')}
                    </span>
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
                </label>
            )}
            {!isLocal && (
                <Menu>
                    <MenuTrigger
                        render={
                            <Button
                                aria-label={t('sshHost.settings.moreFor', { name: host.name })}
                                className="size-6 min-h-0 p-0 text-muted hover:text-foreground"
                                size="icon"
                                variant="ghost"
                            />
                        }
                    >
                        <EllipsisVertical size={14} />
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
 * Settings › Hosts: one card with a row per machine this window reaches (display name, icon, connection, and whether it
 * reconnects on launch), ending in the row that connects another. Changes are this Mac's own and apply at once (Desktop
 * Main stores them).
 */
export function HostsSettingsForm() {
    const { t } = useTranslation();
    const hosts = useEnvironmentStore((store) => store.hosts);
    const preferences = useHostPreferencesStore((store) => store);
    const ids = useMemo(() => listedHostIds(hosts, preferences), [hosts, preferences]);
    const hasActionColumns = ids.length > 0;
    return (
        <div className="@container/hosts" data-testid="hosts-settings">
            <div
                className={cn(
                    'grid rounded-md border border-border bg-surface',
                    hasActionColumns
                        ? 'grid-cols-[auto_minmax(0,1fr)_auto_auto] @2xl/hosts:grid-cols-[auto_minmax(0,1fr)_10rem_10rem_auto_auto]'
                        : 'grid-cols-[auto_minmax(0,1fr)] @2xl/hosts:grid-cols-[auto_minmax(0,1fr)_10rem_10rem]',
                )}
            >
                <HostSettingRow environmentId={undefined} hasActionColumns={hasActionColumns} />
                {ids.map((id) => (
                    <HostSettingRow
                        key={id}
                        environmentId={id}
                        hasActionColumns={hasActionColumns}
                    />
                ))}
                <div className={cn(HOST_CARD_ROW, 'px-2 py-2')}>
                    <Button
                        className="col-span-full justify-self-start text-[12px] text-muted hover:text-foreground"
                        size="sm"
                        variant="ghost"
                        onClick={openConnectSshHostDialog}
                    >
                        <Plus size={14} />
                        {t('sshHost.settings.connect')}
                    </Button>
                </div>
            </div>
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
