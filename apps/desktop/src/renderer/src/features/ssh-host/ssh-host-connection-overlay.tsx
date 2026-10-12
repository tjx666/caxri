import { useEffect, useRef } from 'react';

import type { SshEnvironmentState } from '@caxri/protocol';
import { Server } from 'lucide-react';

import { useModalRegistration } from '@/hooks/use-modal-registration';

import { Button } from '../../components/ui/button';
import { Progress } from '../../components/ui/progress';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { useSshEnvironment } from '../../stores/environment';
import {
    canReconnect,
    connectionFailureKey,
    connectionPhaseLabelKey,
    installProgressPercent,
    isConnectionBusy,
    isConnectionOverlayVisible,
} from './connection-status';
import { reconnectSshHost } from './ssh-host-commands';

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
    /**
     * Pulls focus off the Workbench underneath, where a focused Terminal would otherwise keep taking keystrokes for a
     * Server that cannot receive them.
     */
    useEffect(() => {
        panelReference.current?.focus();
    }, []);
    return (
        <div
            ref={panelReference}
            aria-labelledby="ssh-host-connection-title"
            aria-modal="true"
            className="ssh-host-connection-overlay fixed inset-0 z-40 flex items-center justify-center bg-background outline-none [-webkit-app-region:drag]"
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
                    {t(connectionPhaseLabelKey(environment.phase))}
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
                {environment.failure && (
                    <div className="flex flex-col gap-1">
                        <p className="m-0 text-[13px] text-danger">
                            {t(connectionFailureKey(environment.failure.reason))}
                        </p>
                        {environment.failure.message && (
                            <p className="m-0 font-mono text-[11px] break-words whitespace-pre-wrap text-muted">
                                {environment.failure.message}
                            </p>
                        )}
                    </div>
                )}
                {environment.needsUserAction && !environment.askpass && (
                    <p className="m-0 text-[11px] text-muted">{t('sshHost.needsUserAction')}</p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <Button variant="secondary" onClick={() => window.close()}>
                        {t('sshHost.closeWindow')}
                    </Button>
                    {canReconnect(environment) && (
                        <Button
                            // eslint-disable-next-line no-void -- reconnectSshHost reports its own failure through a toast
                            onClick={() => void reconnectSshHost()}
                        >
                            {t('sshHost.reconnect')}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
