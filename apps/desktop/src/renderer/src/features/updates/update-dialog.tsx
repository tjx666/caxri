import { useEffect } from 'react';

import type { UpdateState } from '@caxri/protocol';
import { isUpdateVersionSkipped } from '@caxri/protocol';
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
import { useSettings } from '../../stores/selectors';
import {
    cancelUpdateDownload,
    checkForUpdates,
    clearSkippedUpdateVersion,
    closeUpdateDialog,
    downloadUpdate,
    openDownloadedUpdate,
    skipUpdateVersion,
    subscribeUpdateState,
    useUpdateStore,
} from './update-commands';
import {
    canRetryUpdateCheck,
    describeUpdateStatus,
    shouldExplainUnsignedInstall,
} from './update-presentation';

function UpdateActions({
    state,
    isSkipped,
}: {
    state: UpdateState | undefined;
    isSkipped: boolean;
}) {
    if (!state || state.status === 'checking')
        return (
            <Button disabled>
                <Spinner aria-hidden="true" className="size-3.5" />
                Checking…
            </Button>
        );
    if (state.status === 'available')
        return isSkipped ? (
            <Button
                onClick={() => {
                    // eslint-disable-next-line no-void -- tryCommand reports its own failure
                    void clearSkippedUpdateVersion();
                }}
            >
                <RefreshCw aria-hidden="true" size={14} />
                Stop Skipping
            </Button>
        ) : (
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
        <Button onClick={checkForUpdates} disabled={!canRetryUpdateCheck(state)}>
            <RefreshCw aria-hidden="true" size={14} />
            {state.status === 'error' ? 'Retry' : 'Check Again'}
        </Button>
    );
}

const STATUS_ICON = { 'aria-hidden': true, 'className': 'mt-0.5 shrink-0', 'size': 18 } as const;

/**
 * Success, failure, and everything in between. The neutral download glyph is the default because most states are steps
 * on the way to one, not outcomes: only a finished download and an up-to-date install have earned a color.
 */
function UpdateStatusIcon({ state }: { state: UpdateState | undefined }) {
    if (state?.status === 'ready' || state?.status === 'up-to-date')
        return (
            <CheckCircle2 {...STATUS_ICON} className={`${STATUS_ICON.className} text-success`} />
        );
    if (state?.status === 'error')
        return <XCircle {...STATUS_ICON} className={`${STATUS_ICON.className} text-danger`} />;
    return <Download {...STATUS_ICON} className={`${STATUS_ICON.className} text-muted`} />;
}

export function UpdateDialog() {
    const isOpen = useUpdateStore((store) => store.open);
    const state = useUpdateStore((store) => store.state);
    const skippedVersion = useSettings()?.['updates.skippedVersion'];
    const isSkipped =
        state?.status === 'available' && isUpdateVersionSkipped(state.version, skippedVersion);
    const copy = describeUpdateStatus(state, { skippedVersion });
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
                        <UpdateStatusIcon state={state} />
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
                    {shouldExplainUnsignedInstall(state) && (
                        <Alert variant="info" className="bg-background p-3 leading-[1.5]">
                            Caxri is currently unsigned. After opening the verified DMG, drag Caxri
                            to Applications and approve replacing the existing app. Running
                            Terminals are not interrupted by the download.
                        </Alert>
                    )}
                    <div className="flex justify-end gap-2">
                        {/*
                         * `Close` and `Skip This Version` sit side by side because they are different answers, not two
                         * strengths of the same one: closing means "not now" and Caxri offers the release again on the
                         * next launch, while skipping is recorded per version and outlasts the process. Treating a
                         * reflexive Escape as a skip would bury the update for someone who never decided anything.
                         */}
                        <Button variant="secondary" onClick={closeUpdateDialog}>
                            Close
                        </Button>
                        {state?.status === 'available' && !isSkipped && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    // eslint-disable-next-line no-void -- tryCommand reports its own failure
                                    void skipUpdateVersion(state.version);
                                }}
                            >
                                Skip This Version
                            </Button>
                        )}
                        <UpdateActions state={state} isSkipped={isSkipped} />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
