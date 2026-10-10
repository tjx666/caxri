import { useState } from 'react';

import { Package, SquareSlash } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Spinner } from '../../components/ui/spinner';
import { useCaxriQuery } from '../../queries/client';
import { AgentChatMessage } from './agent-chat-message';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';

const CHIP_CLASS_NAME =
    'inline-flex max-w-full items-center gap-1 rounded-md bg-accent/15 px-1.5 align-baseline font-medium text-accent';

/**
 * The skill or command a sent message starts with, set apart from what the user asked of it. Clicking it opens the
 * skill's rendered instructions in a popover, so the transcript shows what the Agent was told to follow. The file is
 * read only while the popover is open.
 */
export function AgentChatInvocationChip({ invocation }: { invocation: string }) {
    const terminalId = useAgentChatTerminal();
    const [isOpen, setIsOpen] = useState(false);
    const Icon = invocation.startsWith('$') ? Package : SquareSlash;
    const label = (
        <>
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{invocation.slice(1)}</span>
        </>
    );
    if (!terminalId) return <span className={CHIP_CLASS_NAME}>{label}</span>;
    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger
                aria-label={`Show ${invocation}`}
                className={`${CHIP_CLASS_NAME} cursor-pointer border-0 text-[13px] leading-5 transition-[background-color,scale] duration-150 hover:bg-accent/25 focus-visible:outline focus-visible:outline-accent active:scale-[0.97] data-popup-open:bg-accent/25`}
            >
                {label}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[28rem]" side="bottom">
                {isOpen && (
                    <AgentChatInvocationDetails invocation={invocation} terminalId={terminalId} />
                )}
            </PopoverContent>
        </Popover>
    );
}

function AgentChatInvocationDetails({
    invocation,
    terminalId,
}: {
    invocation: string;
    terminalId: string;
}) {
    const action = useCaxriQuery('agentActions.read', { terminalId, invocation }, { retry: false });
    return (
        <div className="flex max-h-[min(28rem,var(--available-height))] flex-col">
            <div className="flex flex-col gap-0.5 border-b border-border px-3 py-2">
                <span className="font-mono text-[12px] text-foreground">{invocation}</span>
                {action.data?.description && (
                    <span className="text-[12px] leading-4 text-muted">
                        {action.data.description}
                    </span>
                )}
            </div>
            <div className="min-h-0 overflow-y-auto px-3 py-2.5">
                {action.isPending && <Spinner className="size-3.5" />}
                {action.error && (
                    <p className="m-0 text-[12px] text-muted">{action.error.message}</p>
                )}
                {action.data && (
                    <AgentChatMessage isStreaming={false} text={action.data.markdown} />
                )}
            </div>
        </div>
    );
}
