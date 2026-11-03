import { useEffect, useRef } from 'react';

import type { SshEnvironmentState } from '@caxri/protocol';
import { Server } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { environmentIdOf, useSshEnvironment } from '../../stores/environment';
import {
    canCancelConnection,
    canReconnect,
    canRetryNow,
    connectionFailureCopy,
    connectionFailureDetail,
    connectionFailureTone,
    connectionPhaseLabel,
    hostKeyResetCommand,
    installProgressPercent,
    isConnectionBusy,
    isConnectionOverlayVisible,
    isConnectionSettled,
    isRetryAttemptRunning,
    reconnectLabelKey,
} from './connection-status';
import {
    cancelSshHostConnection,
    disconnectSshHost,
    reconnectSshHost,
    retrySshHostNow,
} from './ssh-host-commands';
import { SshHostCopyButton } from './ssh-host-copy-button';

const failureToneClassNames = {
    danger: 'text-danger',
    muted: 'text-muted',
    warning: 'text-warning',
} as const;

/**
 * Shows the connection of the SSH Host the selected Session lives on whenever its Server is not usable. It floats as a
 * card over the Workbench, which stays readable and usable: the side bar still reaches this Mac's and every other
 * Host's Sessions, so nothing else waits on this one Host.
 */
export function SshHostConnectionOverlay() {
    const environment = useSshEnvironment();
    if (!environment || !isConnectionOverlayVisible(environment)) return null;
    return <ConnectionPanel key={environmentIdOf(environment)} environment={environment} />;
}

const placement = {
    card: 'pointer-events-auto rounded-lg border border-border bg-surface p-4 shadow-[0_16px_48px_var(--shadow)]',
    container: 'pointer-events-none inset-x-0 top-12',
};

function ConnectionPanel({ environment }: { environment: SshEnvironmentState }) {
    const { t } = useTranslation();
    const panelReference = useRef<HTMLDivElement>(null);
    const isBusy = isConnectionBusy(environment.phase);
    const isSettled = isConnectionSettled(environment.phase);
    const isReconnectable = canReconnect(environment);
    const phaseLabel = connectionPhaseLabel(environment);
    const { failure } = environment;
    const resetCommand = hostKeyResetCommand(failure);
    const detail = connectionFailureDetail(failure);
    const environmentId = environmentIdOf(environment);
    /**
     * Pulls focus off the Session underneath, where a focused Terminal would otherwise keep taking keystrokes for a
     * Server that cannot receive them. Once the connection gives up, focus moves to the action that resolves it, so a
     * keyboard user can press Enter on Reconnect (or Disconnect when reconnecting cannot help).
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
            className={cn(
                'ssh-host-connection-overlay fixed z-40 flex justify-center outline-none',
                placement.container,
            )}
            role="region"
            tabIndex={-1}
        >
            <div
                className={cn(
                    'flex w-[min(440px,calc(100vw-48px))] flex-col gap-3 [-webkit-app-region:no-drag]',
                    placement.card,
                )}
            >
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
                <InstallProgress environment={environment} />
                <p className="m-0 text-[12px] text-muted">{t('sshHost.workbenchPaused')}</p>
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
                        // eslint-disable-next-line no-void -- disconnectSshHost reports its own failure through a toast
                        onClick={() => void disconnectSshHost(environmentId)}
                    >
                        {t('sshHost.disconnect')}
                    </Button>
                    <RetryNowButton environment={environment} />
                    {canCancelConnection(environment) && (
                        <Button
                            variant="secondary"
                            // eslint-disable-next-line no-void -- cancelSshHostConnection reports its own failure through a toast
                            onClick={() => void cancelSshHostConnection(environmentId)}
                        >
                            {t('common.cancel')}
                        </Button>
                    )}
                    {isReconnectable && (
                        <Button
                            data-ssh-host-primary
                            // eslint-disable-next-line no-void -- reconnectSshHost reports its own failure through a toast
                            onClick={() => void reconnectSshHost(environmentId)}
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
 * How far the Server install on the SSH Host has come; shown only while installing.
 */
function InstallProgress({ environment }: { environment: SshEnvironmentState }) {
    const { t } = useTranslation();
    if (environment.phase !== 'installing') return null;
    const percent = installProgressPercent(environment);
    return (
        <div className="flex items-center gap-2">
            <Progress aria-label={t('sshHost.progress.label')} value={percent ?? null} />
            {percent !== undefined && (
                <span className="flex-none text-[11px] text-muted tabular-nums">
                    {t('sshHost.progress.percent', { percent })}
                </span>
            )}
        </div>
    );
}

/**
 * Skips the reconnect backoff's remaining wait; disabled while the attempt it started is still running.
 */
function RetryNowButton({ environment }: { environment: SshEnvironmentState }) {
    const { t } = useTranslation();
    if (!canRetryNow(environment)) return null;
    const isRunning = isRetryAttemptRunning(environment);
    return (
        <Button
            variant="secondary"
            disabled={isRunning}
            // eslint-disable-next-line no-void -- retrySshHostNow reports its own failure through a toast
            onClick={() => void retrySshHostNow(environmentIdOf(environment))}
        >
            {isRunning && <Spinner />}
            {t('sshHost.retryNow')}
        </Button>
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
