import type { AgentChatUsageLimit } from '@caxri/protocol';
import { Clock } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { useClockTick } from '../hooks/use-clock-tick';
import { agentChatAutoContinueLabel } from './agent-chat-continuation';

type AutoContinue = NonNullable<AgentChatUsageLimit['autoContinue']>;

/**
 * Whether the Chat continues on its own once its limit resets (issue #2220), as one muted line: when it continues, that
 * it did, that the reset passed, or why it never waited. The actions sit with the notice's other buttons.
 */
export function AgentChatAutoContinueLine({ autoContinue }: { autoContinue: AutoContinue }) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    return (
        <div
            className="flex min-w-0 items-center gap-1.5 text-muted"
            data-agent-chat-auto-continue={autoContinue.status}
        >
            <Clock aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
                {agentChatAutoContinueLabel(autoContinue, now, t)}
            </span>
        </div>
    );
}
