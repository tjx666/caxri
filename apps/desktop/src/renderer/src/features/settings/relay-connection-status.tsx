import { Spinner } from '../../components/ui/spinner';
import { usePolledQuery } from '../../hooks/use-polled-query';
import { useTranslation } from '../../i18n';
import { presentRelayConnection } from './relay-connection-presentation';

/**
 * How often the open Settings page re-reads the Relay registration. The Server has no push event for it, and a short
 * poll while the row is on screen shows a fixed address start working within a couple of seconds.
 */
const RELAY_STATUS_POLL_MS = 2_000;

/**
 * The live caption under the Relay server row: whether this computer is registered with the Relay and, when it is not,
 * the closed reason of the last failure. Renders nothing while no Relay is configured or Mobile access is off.
 */
export function RelayConnectionStatus() {
    const { t } = useTranslation();
    const { data } = usePolledQuery('mobile.access.status', undefined, {
        intervalMs: RELAY_STATUS_POLL_MS,
        label: 'settings.relayConnection',
    });
    const presentation = presentRelayConnection(data?.relay);
    if (!presentation) return null;
    return (
        <p
            role="status"
            data-slot="relay-connection-status"
            data-kind={presentation.kind}
            className="m-0 flex items-start gap-1.5 text-[11px] leading-[1.45]"
        >
            {presentation.kind === 'connecting' ? (
                <Spinner className="mt-0.5 size-3 flex-none text-muted" />
            ) : (
                <span
                    aria-hidden="true"
                    className={
                        presentation.kind === 'connected'
                            ? 'mt-1 size-1.5 flex-none rounded-full bg-success'
                            : 'mt-1 size-1.5 flex-none rounded-full bg-danger'
                    }
                />
            )}
            <span
                className={
                    presentation.kind === 'failed' ? 'min-w-0 text-danger' : 'min-w-0 text-muted'
                }
            >
                {t(presentation.labelKey)}
                {presentation.reasonKey ? ` ${t(presentation.reasonKey)}` : null}
            </span>
        </p>
    );
}
