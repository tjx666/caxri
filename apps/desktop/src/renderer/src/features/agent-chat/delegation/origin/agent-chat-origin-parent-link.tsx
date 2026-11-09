import { Tooltip } from '@/components/ui/tooltip';

import { useTranslation } from '../../../../i18n';
import { openSession } from '../../../session/session-commands';

/**
 * The parent Session's name inside an origin row's sentence ("Delegated by <name>", "Started from <name>"). The name is
 * the way back, so the row names the parent once instead of repeating it in a separate "Back to" link. An archived
 * parent is plain text, because navigating to it never restores it.
 */
export function AgentChatOriginParentLink({
    isArchived,
    parentId,
    title,
}: {
    isArchived: boolean;
    parentId: string;
    title: string;
}) {
    const { t } = useTranslation();
    if (isArchived) return <span className="text-foreground">{title}</span>;
    const label = t('delegation.origin.back', { title });
    return (
        <Tooltip content={label}>
            <button
                aria-label={label}
                className="inline cursor-pointer border-0 bg-transparent p-0 text-xs text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => openSession(parentId)}
            >
                {title}
            </button>
        </Tooltip>
    );
}
