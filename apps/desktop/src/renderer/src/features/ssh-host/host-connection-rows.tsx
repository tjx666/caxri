import type { ProjectRecord } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { environmentIdOf, useEnvironmentStore } from '../../stores/environment';
import { hostDisplayOf, useHostPreference } from '../../stores/host-preferences';
import {
    canReconnect,
    connectionFailureTone,
    connectionPhaseLabel,
    connectionToneClasses,
    isConnectionBusy,
} from './connection-status';
import { remoteMachinesOf } from './remote-machines';
import { reconnectSshHost } from './ssh-host-commands';

/**
 * Under an expanded Project heading, the connection of one SSH Host the Project lives on while it is not usable: a
 * spinner while Main restores it, the failure with Reconnect once it gave up. Renders nothing while connected, and for
 * a Host this window has disconnected (its Projects have left the side bar).
 */
function HostConnectionRow({
    environmentId,
    named = false,
}: {
    environmentId: string;
    /**
     * Prefixes the Host's name, for a Project that lives on more than one machine.
     */
    named?: boolean;
}) {
    const { t } = useTranslation();
    const state = useEnvironmentStore((store) =>
        store.hosts.find((host) => environmentIdOf(host) === environmentId),
    );
    const preference = useHostPreference(environmentId);
    if (!state || state.phase === 'connected') return null;
    const label = connectionPhaseLabel(state);
    const tone = connectionToneClasses(connectionFailureTone(state));
    const text = `${named ? `${hostDisplayOf(environmentId, preference).name}: ` : ''}${t(label.key, label.values)}`;
    return (
        <div
            className="flex min-h-7 items-center gap-2 py-0.5 pr-1 pl-6 text-[11px]"
            data-testid="host-connection-row"
        >
            {isConnectionBusy(state.phase) ? (
                <>
                    <Spinner className="size-3 flex-none text-muted" />
                    <span className="min-w-0 flex-1 truncate text-muted">{text}</span>
                </>
            ) : (
                <>
                    <span className={`size-1.5 flex-none rounded-full ${tone.dot}`} />
                    <span className={`min-w-0 flex-1 truncate ${tone.text}`}>{text}</span>
                    {canReconnect(state) && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                void reconnectSshHost(environmentId);
                            }}
                        >
                            {t('sshHost.reconnect')}
                        </Button>
                    )}
                </>
            )}
        </div>
    );
}

/**
 * The connection rows of every SSH Host a heading's Projects live on, each named when there is more than one Project.
 */
export function HostConnectionRows({ members }: { members: readonly ProjectRecord[] }) {
    return remoteMachinesOf(members).map((environmentId) => (
        <HostConnectionRow
            key={environmentId}
            environmentId={environmentId}
            named={members.length > 1}
        />
    ));
}
