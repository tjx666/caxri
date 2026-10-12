import { CircleAlert, Lightbulb } from 'lucide-react';

import { ReportCard } from '../../../components/report-card';
import { useTranslation } from '../../../i18n';
import type { ContextSuggestion } from './suggestions';

/**
 * Hidden when nothing stands out: an empty "all good" card would only push the measurements down.
 */
export function ContextSuggestionsCard({
    suggestions,
}: {
    suggestions: readonly ContextSuggestion[];
}) {
    const { t } = useTranslation();
    if (suggestions.length === 0) return null;
    return (
        <ReportCard title={t('agentChat.contextPage.suggestion.title')}>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {suggestions.map((suggestion) => (
                    <li
                        key={suggestion.id}
                        className="flex items-start gap-2 text-[12px] leading-[1.5] text-pretty"
                    >
                        {suggestion.tone === 'warning' ? (
                            <CircleAlert
                                aria-hidden="true"
                                className="mt-0.5 shrink-0 text-warning"
                                size={14}
                            />
                        ) : (
                            <Lightbulb
                                aria-hidden="true"
                                className="mt-0.5 shrink-0 text-muted"
                                size={14}
                            />
                        )}
                        <span>{suggestion.text}</span>
                    </li>
                ))}
            </ul>
        </ReportCard>
    );
}
