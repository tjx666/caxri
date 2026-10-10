import type { AgentChatItemStatus } from '@caxri/protocol';
import { Check, Circle, CircleSlash, CircleX } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import type { AgentChatStatusTone } from './agent-chat-presentation';
import { agentChatItemStatusLabel, agentChatItemStatusTone } from './agent-chat-presentation';

const toneClassName: Record<AgentChatStatusTone, string> = {
    danger: 'text-danger',
    muted: 'text-muted',
    running: 'text-muted',
    success: 'text-success',
    warning: 'text-warning',
};

/**
 * Status glyph for an activity row. The accessible name carries the state, so the glyph never stands alone.
 */
export function AgentChatStatusGlyph({ status }: { status: AgentChatItemStatus }) {
    const label = agentChatItemStatusLabel(status);
    const className = cn('size-3.5 shrink-0', toneClassName[agentChatItemStatusTone(status)]);
    switch (status) {
        case 'running': {
            return <Spinner aria-label={label} className={className} />;
        }
        case 'completed': {
            return <Check aria-label={label} className={className} role="img" />;
        }
        case 'failed': {
            return <CircleX aria-label={label} className={className} role="img" />;
        }
        case 'declined': {
            return <CircleSlash aria-label={label} className={className} role="img" />;
        }
        case 'interrupted': {
            return <Circle aria-label={label} className={className} role="img" />;
        }
    }
}
