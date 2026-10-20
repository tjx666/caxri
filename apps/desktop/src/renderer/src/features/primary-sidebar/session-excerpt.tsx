import type { SessionRecord } from '@caxri/protocol';

import { useSessionExcerpts } from '@/hooks/use-session-excerpts';

import { useTranslation } from '../../i18n';

/**
 * What the Agent is waiting on or last said, quoted in the Session hover card and clamped to three lines. User content:
 * shown locally only.
 */
export function SessionExcerpt({
    isVisible,
    session,
}: {
    isVisible: boolean;
    session: Pick<SessionRecord, 'attentionEpoch' | 'id'>;
}) {
    const { t } = useTranslation();
    const excerpt = useSessionExcerpts([session], isVisible)[session.id];
    if (!excerpt) return null;
    return (
        <div className="mt-2 text-[11px] leading-[1.45]">
            <span className="font-medium text-muted">
                {t(
                    excerpt.kind === 'request'
                        ? 'primarySidebar.card.excerptRequest'
                        : 'primarySidebar.card.excerptReply',
                )}
            </span>
            <p className="mt-0.5 mb-0 line-clamp-3 wrap-break-word text-foreground">
                {excerpt.text}
            </p>
        </div>
    );
}
