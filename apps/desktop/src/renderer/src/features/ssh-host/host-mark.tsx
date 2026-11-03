import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { environmentIdOf, useEnvironmentStore } from '../../stores/environment';
import {
    hostDisplayOf,
    useHostPreference,
    useHostPreferencesStore,
} from '../../stores/host-preferences';
import { isConnectionSettled } from './connection-status';
import { HostGlyph } from './host-glyph';

/**
 * Shows which SSH Host a record lives on (GLOSSARY "Host mark"): the Host's glyph, its display name, and a spinner
 * while the connection is being restored or a dot once it failed. Renders nothing for this Mac's records, which carry
 * no mark. The name always sits in the tooltip.
 */
export function HostMark({
    className,
    display = 'auto',
    environmentId,
}: {
    className?: string;
    /**
     * `auto` (Project headings) shows the name unless the user chose an icon for this Host; `icon` (Session rows) shows
     * the glyph alone. "Show Host Names Next to Icons" turns both back into glyph and name.
     */
    display?: 'auto' | 'icon';
    environmentId: string | undefined;
}) {
    const { t } = useTranslation();
    const phase = useEnvironmentStore((store) =>
        environmentId === undefined
            ? undefined
            : store.hosts.find((candidate) => environmentIdOf(candidate) === environmentId)?.phase,
    );
    const preference = useHostPreference(environmentId);
    const shouldShowHostNames = useHostPreferencesStore((store) => store.shouldShowHostNames);
    if (environmentId === undefined) return null;
    const host = hostDisplayOf(environmentId, preference);
    const isIconOnly = !shouldShowHostNames && (display === 'icon' || host.icon !== undefined);
    const destination = host.destination ?? environmentId;
    return (
        <Tooltip
            content={
                host.name === destination
                    ? t('sshHost.hostMark', { destination })
                    : t('sshHost.hostMark.named', { destination, name: host.name })
            }
        >
            <span
                className={cn(
                    'inline-flex max-w-28 min-w-0 flex-none items-center gap-1 text-[11px] font-normal text-muted',
                    className,
                )}
                data-testid="host-mark"
            >
                <HostGlyph icon={host.icon} system={host.system} />
                {!isIconOnly && <span className="truncate">{host.name}</span>}
                {phase === undefined || phase === 'stopped' || isConnectionSettled(phase) ? (
                    <span className="size-1.5 flex-none rounded-full bg-danger" />
                ) : phase === 'connected' ? null : (
                    <Spinner className="size-3 flex-none" />
                )}
            </span>
        </Tooltip>
    );
}
