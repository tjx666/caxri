import { useEffect, useRef } from 'react';

import type { SshEnvironmentState } from '@caxri/protocol';
import { Server } from 'lucide-react';

import { useModalRegistration } from '@/hooks/use-modal-registration';

import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useSshEnvironment } from '../../stores/environment';
import {
    canCancelConnection,
    canReconnect,
    connectionFailureCopy,
    connectionFailureDetail,
    connectionFailureTone,
    connectionPhaseLabel,
    hostKeyResetCommand,
    installProgressPercent,
    isConnectionBusy,
    isConnectionOverlayVisible,
    isConnectionSettled,
    reconnectLabelKey,
} from './connection-status';
import { cancelSshHostConnection, reconnectSshHost } from './ssh-host-commands';
import { SshHostCopyButton } from './ssh-host-copy-button';

const failureToneClassNames = {
    danger: 'text-danger',
    muted: 'text-muted',
    warning: 'text-warning',
} as const;

/**
 * Covers an SSH Host window whenever its Server is not usable: before the first attach (in place of the otherwise empty
 * `LoadingScreen`) and over an attached Workbench while a reconnect runs, whose requests would only fail. It is opaque
 * so the user never acts on a Workbench that cannot answer.
 */
export function SshHostConnectionOverlay() {
    const environment = useSshEnvironment();
    const isVisible = isConnectionOverlayVisible(environment);
    useModalRegistration(isVisible);
    if (!environment || !isVisible) return null;
    return <ConnectionPanel environment={environment} />;
}

function ConnectionPanel({ environment }: { environment: SshEnvironmentState }) {
    const { t } = useTranslation();
    const panelReference = useRef<HTMLDivElement>(null);
    const percent = installProgressPercent(environment);
    const isBusy = isConnectionBusy(environment.phase);
    const isSettled = isConnectionSettled(environment.phase);
    const isReconnectable = canReconnect(environment);
    const phaseLabel = connectionPhaseLabel(environment);
    const { failure } = environment;
    const resetCommand = hostKeyResetCommand(failure);
    const detail = connectionFailureDetail(failure);
    /**
     * Pulls focus off the Workbench underneath, where a focused Terminal would otherwise keep taking keystrokes for a
     * Server that cannot receive them. Once the connection gives up, focus moves to the action that resolves it, so a
     * keyboard user can press Enter on Reconnect (or Close Window when reconnecting cannot help).
     */
    useEffect(() => {
        const panel = panelReference.current;
        if (!panel) return;
        const primary = isSettled
            ? panel.querySelector<HTMLElement>('[data-ssh-host-primary]')
            : null;
        (primary ?? panel).focus();
    }, [isSettled]);
    return (
        <div
            ref={panelReference}
            aria-labelledby="ssh-host-connection-title"
            aria-modal="true"
            className="ssh-host-connection-overlay fixed inset-0 z-40 flex items-center justify-center bg-background outline-none [-webkit-app-region:drag]"
            // A native <dialog> would dismiss on Escape; this full-window state cannot be dismissed until the Server attaches.
            // react-doctor-disable-next-line react-doctor/prefer-html-dialog
            role="dialog"
            tabIndex={-1}
        >
            <div className="flex w-[min(440px,calc(100vw-48px))] flex-col gap-3 [-webkit-app-region:no-drag]">
                <h1
                    id="ssh-host-connection-title"
                    className="m-0 flex items-center gap-2 text-[15px] font-semibold text-foreground"
                >
                    <Server aria-hidden="true" className="text-muted" size={16} />
                    <span className="min-w-0 truncate">
                        {t('sshHost.windowTitle', { destination: environment.destination })}
                    </span>
                </h1>
                <p
                    aria-live="polite"
                    className="m-0 flex items-center gap-2 text-[13px] text-foreground"
                    role="status"
                >
                    {isBusy && <Spinner className="text-muted" />}
                    {t(phaseLabel.key, phaseLabel.values)}
                </p>
                {environment.phase === 'installing' && (
                    <div className="flex items-center gap-2">
                        <Progress
                            aria-label={t('sshHost.progress.label')}
                            value={percent ?? null}
                        />
                        {percent !== undefined && (
                            <span className="flex-none text-[11px] text-muted tabular-nums">
                                {t('sshHost.progress.percent', { percent })}
                            </span>
                        )}
                    </div>
                )}
                {failure && (
                    <ConnectionFailure
                        detail={detail}
                        failure={failure}
                        isAlert={isSettled}
                        tone={failureToneClassNames[connectionFailureTone(environment)]}
                    />
                )}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    {detail && isSettled && (
                        <SshHostCopyButton label={t('sshHost.copyDetails')} text={detail} />
                    )}
                    {resetCommand && (
                        <SshHostCopyButton label={t('sshHost.copyCommand')} text={resetCommand} />
                    )}
                    <span className="flex-1" />
                    <Button
                        data-ssh-host-primary={isReconnectable ? undefined : true}
                        variant={isReconnectable || isBusy ? 'secondary' : 'default'}
                        onClick={() => window.close()}
                    >
                        {t('sshHost.closeWindow')}
                    </Button>
                    {canCancelConnection(environment) && (
                        <Button
                            variant="secondary"
                            // eslint-disable-next-line no-void -- cancelSshHostConnection reports its own failure through a toast
                            onClick={() => void cancelSshHostConnection()}
                        >
                            {t('common.cancel')}
                        </Button>
                    )}
                    {isReconnectable && (
                        <Button
                            data-ssh-host-primary
                            // eslint-disable-next-line no-void -- reconnectSshHost reports its own failure through a toast
                            onClick={() => void reconnectSshHost()}
                        >
                            {t(reconnectLabelKey(environment))}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Why the connection stopped, and OpenSSH's or the SSH Host's own words for it. Announced as an alert once the
 * connection gives up; while a reconnect keeps trying, the cause is shown without interrupting.
 */
function ConnectionFailure({
    detail,
    failure,
    isAlert,
    tone,
}: {
    detail: string | undefined;
    failure: NonNullable<SshEnvironmentState['failure']>;
    isAlert: boolean;
    tone: string;
}) {
    const { t } = useTranslation();
    const copy = connectionFailureCopy(failure);
    return (
        <div className="flex flex-col gap-1" role={isAlert ? 'alert' : undefined}>
            <p className={cn('m-0 text-[13px]', tone)}>{t(copy.key, copy.values)}</p>
            {detail && (
                <p className="m-0 font-mono text-[11px] break-words whitespace-pre-wrap text-muted">
                    {detail}
                </p>
            )}
        </div>
    );
}
