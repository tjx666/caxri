import { useState } from 'react';

import { FileCog, Server } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { useCaxriQuery } from '../../queries/client';
import type { SshHostPickerRow } from './ssh-destination';
import { buildSshHostPickerRows } from './ssh-destination';
import { connectToSshHost, revealSshConfig } from './ssh-host-commands';
import { setConnectSshHostOpen, useSshHostDialogsStore } from './ssh-host-dialogs-store';

const NO_HOSTS: never[] = [];

/**
 * The `Connect to SSH Host…` picker: the typed destination first, then recent destinations, then `~/.ssh/config` hosts.
 * Mounted for the app's lifetime; the Portal renders the body (and its `~/.ssh/config` read) only while open.
 */
export function ConnectSshHostDialog() {
    const isOpen = useSshHostDialogsStore((state) => state.isConnectOpen);
    return (
        <Dialog open={isOpen} onOpenChange={setConnectSshHostOpen}>
            <PickerDialogContent>
                <ConnectSshHostBody />
            </PickerDialogContent>
        </Dialog>
    );
}

function ConnectSshHostBody() {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const hostsQuery = useCaxriQuery('remote.hosts.list', {}, { staleTime: 0 });
    const rows = buildSshHostPickerRows({
        hosts: hostsQuery.data?.hosts ?? NO_HOSTS,
        query,
        recent: hostsQuery.data?.recent ?? NO_HOSTS,
    });
    const hasRows = rows.typed !== undefined || rows.recent.length > 0 || rows.hosts.length > 0;
    return (
        <>
            <DialogTitle className="sr-only">{t('sshHost.connect.title')}</DialogTitle>
            {/* Filtering is done by `buildSshHostPickerRows`, which also knows the typed destination is not a match. */}
            <Command label={t('sshHost.connect.title')} shouldFilter={false} className="w-full">
                <CommandInput
                    autoFocus
                    aria-label={t('sshHost.connect.inputLabel')}
                    placeholder={t('sshHost.connect.placeholder')}
                    spellCheck={false}
                    value={query}
                    onValueChange={setQuery}
                />
                <CommandList>
                    {rows.isInvalid && (
                        <p className="m-0 px-2 py-1 text-[11px] text-danger" role="status">
                            {t('sshHost.connect.invalid')}
                        </p>
                    )}
                    {hostsQuery.isError && (
                        <p className="m-0 px-2 py-1 text-[11px] text-muted" role="status">
                            {t('sshHost.connect.loadFailed')}
                        </p>
                    )}
                    {!rows.isInvalid && !hasRows && hostsQuery.isSuccess && (
                        <CommandEmpty>
                            {t(query.trim() ? 'sshHost.connect.noMatch' : 'sshHost.connect.empty')}
                        </CommandEmpty>
                    )}
                    {rows.typed && (
                        <CommandGroup>
                            <SshHostRow
                                label={t('sshHost.connect.typed', {
                                    destination: rows.typed.destination,
                                })}
                                row={rows.typed}
                            />
                        </CommandGroup>
                    )}
                    {rows.recent.length > 0 && (
                        <CommandGroup heading={t('sshHost.connect.recent')}>
                            {rows.recent.map((row) => (
                                <SshHostRow key={row.destination} row={row} />
                            ))}
                        </CommandGroup>
                    )}
                    {rows.hosts.length > 0 && (
                        <CommandGroup heading={t('sshHost.connect.config')}>
                            {rows.hosts.map((row) => (
                                <SshHostRow key={row.destination} row={row} />
                            ))}
                        </CommandGroup>
                    )}
                </CommandList>
            </Command>
            {/* Adding a Host happens in the SSH config this picker lists, so the way there sits under the list. */}
            <div className="flex h-9 items-center justify-end border-t border-border px-2">
                <Button
                    size="sm"
                    variant="ghost"
                    // eslint-disable-next-line no-void -- revealSshConfig reports its own failure through a toast
                    onClick={() => void revealSshConfig()}
                >
                    <FileCog aria-hidden="true" size={13} />
                    {t('sshHost.connect.openConfig')}
                </Button>
            </div>
        </>
    );
}

function SshHostRow({ label, row }: { label?: string; row: SshHostPickerRow }) {
    const connecting = useSshHostDialogsStore((state) => state.connectingDestination);
    return (
        <CommandItem
            disabled={connecting !== undefined}
            // `cmdk` tracks selection by value; the group prefix keeps a destination listed in two groups distinct.
            value={`${label === undefined ? 'host' : 'typed'}:${row.destination}`}
            // eslint-disable-next-line no-void -- connectToSshHost reports its own failure through a toast
            onSelect={() => void connectToSshHost(row.destination)}
        >
            <span className="flex min-w-0 items-center gap-2">
                <Server aria-hidden="true" className="flex-none text-muted" size={14} />
                <span className="truncate">{label ?? row.destination}</span>
            </span>
            {connecting === row.destination ? (
                <Spinner className="flex-none text-muted" />
            ) : (
                row.detail && (
                    <small className="min-w-0 flex-none truncate text-[11px] text-muted">
                        {row.detail}
                    </small>
                )
            )}
        </CommandItem>
    );
}
