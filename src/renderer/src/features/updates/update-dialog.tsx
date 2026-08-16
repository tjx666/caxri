import { useEffect } from 'react';

import { formatBytes } from '@caxri/utils';
import type { UpdateState } from '@shared/types';
import { CheckCircle2, Download, FolderOpen, RefreshCw, XCircle } from 'lucide-react';

import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { Progress } from '../../components/ui/progress';
import { Spinner } from '../../components/ui/spinner';
import {
    cancelUpdateDownload,
    checkForUpdates,
    downloadUpdate,
    openDownloadedUpdate,
    subscribeUpdateState,
    useUpdateStore,
} from './update-actions';

function statusCopy(state: UpdateState | undefined): {
    title: string;
    description: string;
} {
    if (!state) return { title: 'Loading update status…', description: 'Please wait.' };
    switch (state.status) {
        case 'idle':
            return {
                title: `Caxri ${state.currentVersion}`,
                description: 'Check GitHub Releases for a newer stable version.',
            };
        case 'checking':
            return { title: 'Checking for updates…', description: `Caxri ${state.currentVersion}` };
        case 'unavailable':
            return { title: 'Update checks unavailable', description: state.reason };
        case 'up-to-date':
            return {
                title: 'Caxri is up to date',
                description: `You are running the latest version, ${state.currentVersion}.`,
            };
        case 'available':
            return {
                title: `Caxri ${state.version} is available`,
                description: `Download ${state.fileName} inside Caxri and verify it before opening.`,
            };
        case 'downloading':
            return {
                title: `Downloading Caxri ${state.version}…`,
                description: state.totalBytes
                    ? `${formatBytes(state.receivedBytes)} of ${formatBytes(state.totalBytes)}`
                    : `${formatBytes(state.receivedBytes)} downloaded`,
            };
        case 'ready':
            return {
                title: `Caxri ${state.version} is ready to install`,
                description: 'The DMG passed SHA-256 verification.',
            };
        case 'error':
            return { title: 'Update failed', description: state.message };
    }
}

function UpdateActions({ state }: { state: UpdateState | undefined }) {
    if (!state || state.status === 'checking')
        return (
            <Button disabled>
                <Spinner aria-hidden="true" className="size-3.5" />
                Checking…
            </Button>
        );
    if (state.status === 'available')
        return (
            <Button onClick={downloadUpdate}>
                <Download aria-hidden="true" size={14} />
                Download Update
            </Button>
        );
    if (state.status === 'downloading')
        return (
            <Button variant="secondary" onClick={cancelUpdateDownload}>
                Cancel Download
            </Button>
        );
    if (state.status === 'ready' || (state.status === 'error' && state.action === 'open'))
        return (
            <Button onClick={openDownloadedUpdate}>
                <FolderOpen aria-hidden="true" size={14} />
                Open DMG
            </Button>
        );
    if (state.status === 'error' && state.action === 'download')
        return (
            <Button onClick={downloadUpdate}>
                <Download aria-hidden="true" size={14} />
                Retry Download
            </Button>
        );
    return (
        <Button onClick={checkForUpdates} disabled={state.status === 'unavailable'}>
            <RefreshCw aria-hidden="true" size={14} />
            {state.status === 'error' ? 'Retry' : 'Check Again'}
        </Button>
    );
}

export function UpdateDialog() {
    const isOpen = useUpdateStore((store) => store.open);
    const state = useUpdateStore((store) => store.state);
    const copy = statusCopy(state);
    useEffect(subscribeUpdateState, []);

    const progress =
        state?.status === 'downloading' && state.totalBytes
            ? Math.min(100, (state.receivedBytes / state.totalBytes) * 100)
            : undefined;

    return (
        <Dialog open={isOpen} onOpenChange={(next) => useUpdateStore.getState().setOpen(next)}>
            <DialogContent data-update-status={state?.status ?? 'loading'}>
                <DialogHeader>
                    <DialogTitle>Software Update</DialogTitle>
                    <DialogDescription>
                        Caxri downloads updates from its official GitHub Release.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 p-4">
                    <div className="flex items-start gap-3">
                        {state?.status === 'ready' || state?.status === 'up-to-date' ? (
                            <CheckCircle2
                                aria-hidden="true"
                                className="mt-0.5 shrink-0 text-success"
                                size={18}
                            />
                        ) : state?.status === 'error' ? (
                            <XCircle
                                aria-hidden="true"
                                className="mt-0.5 shrink-0 text-danger"
                                size={18}
                            />
                        ) : (
                            <Download
                                aria-hidden="true"
                                className="mt-0.5 shrink-0 text-muted"
                                size={18}
                            />
                        )}
                        <div className="min-w-0">
                            <p className="m-0 text-[13px] font-medium">{copy.title}</p>
                            <p className="mt-1 mb-0 text-[11px] leading-[1.5] text-muted">
                                {copy.description}
                            </p>
                        </div>
                    </div>
                    {state?.status === 'downloading' && (
                        <Progress
                            aria-label="Update download progress"
                            value={progress === undefined ? null : Math.round(progress)}
                        />
                    )}
                    {(state?.status === 'available' ||
                        state?.status === 'downloading' ||
                        state?.status === 'ready' ||
                        (state?.status === 'error' && state.version)) && (
                        <Alert variant="info" className="bg-background p-3 leading-[1.5]">
                            Caxri is currently unsigned. After opening the verified DMG, drag Caxri
                            to Applications and approve replacing the existing app. Running
                            Terminals are not interrupted by the download.
                        </Alert>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="secondary"
                            onClick={() => useUpdateStore.getState().setOpen(false)}
                        >
                            Close
                        </Button>
                        <UpdateActions state={state} />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
