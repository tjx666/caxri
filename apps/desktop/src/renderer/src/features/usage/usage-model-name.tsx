import { useRef } from 'react';

import { Tooltip } from '../../components/ui/tooltip';
import { useIsOverflowing } from '../../hooks/use-is-overflowing';

/**
 * A Models table model name. Names that share a long prefix (`claude-opus-…`, `gpt-…-codex`) clip to the same few
 * characters in a narrow pane, so a clipped name raises the shared Tooltip with the full name; an unclipped one would
 * only repeat what is already on screen.
 */
export function UsageModelName({ model }: { model: string }) {
    const reference = useRef<HTMLSpanElement>(null);
    const isClipped = useIsOverflowing(reference, model);
    return (
        <Tooltip content={model} disabled={!isClipped}>
            <span ref={reference} className="min-w-0 truncate font-mono text-[11px]">
                {model}
            </span>
        </Tooltip>
    );
}
