import { useMemo } from 'react';

import { cn } from '../../../../lib/utilities';
import { agentChatToolArgumentEntries } from '../agent-chat-tool-argument-entries';

/**
 * An expanded tool call's arguments. A JSON object reads as a name and value list, the way the Codex app sets a tool's
 * input apart from its result, instead of one run-on line of JSON; any other preview is shown as written.
 */
export function AgentChatToolArguments({ text }: { text: string }) {
    const entries = useMemo(() => agentChatToolArgumentEntries(text), [text]);
    if (!entries)
        return (
            <p className="m-0 font-mono text-[11px] wrap-anywhere whitespace-pre-wrap text-muted select-text">
                {text}
            </p>
        );
    return (
        <dl className="m-0 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 select-text">
            {entries.map(({ isCode, name, value }) => (
                <div className="contents" key={name}>
                    <dt className="truncate font-mono text-[11px] leading-5 text-muted">{name}</dt>
                    <dd
                        className={cn(
                            'm-0 wrap-anywhere whitespace-pre-wrap text-foreground',
                            isCode && 'font-mono text-[11px]',
                        )}
                    >
                        {value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
