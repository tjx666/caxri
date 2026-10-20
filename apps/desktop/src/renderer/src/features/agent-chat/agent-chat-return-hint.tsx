import { ArrowUp, X } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import type { AgentChatReturnHintData } from './hooks/use-agent-chat-return-hint';

/**
 * A quiet pill at the top of the transcript telling a returning user how many Agent turns finished while they were
 * away, with a jump to the first of them. It floats over the transcript like Jump to latest, so it moves nothing the
 * user is reading, and it leaves with the Session, a jump, or its close button.
 */
export function AgentChatReturnHint({
    hint,
    onDismiss,
    onJump,
}: {
    hint: AgentChatReturnHintData;
    onDismiss: () => void;
    onJump: (anchorId: string) => void;
}) {
    const { t } = useTranslation();
    const { anchorId, count } = hint;
    const label = t(
        count === 1 ? 'agentChat.returnHint.turnsOne' : 'agentChat.returnHint.turnsOther',
        { count },
    );
    return (
        <div
            className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-elevated py-0.5 pr-0.5 pl-3 text-xs text-foreground shadow-[0_8px_24px_var(--shadow)]"
            role="status"
        >
            <span className="tabular-nums">{label}</span>
            {anchorId !== undefined && (
                <Button
                    className="ml-1"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        onJump(anchorId);
                        onDismiss();
                    }}
                >
                    <ArrowUp aria-hidden="true" className="size-3.5" />
                    {t('agentChat.returnHint.jump')}
                </Button>
            )}
            <Button
                aria-label={t('agentChat.returnHint.dismiss')}
                size="icon"
                variant="ghost"
                onClick={onDismiss}
            >
                <X aria-hidden="true" className="size-3.5" />
            </Button>
        </div>
    );
}
