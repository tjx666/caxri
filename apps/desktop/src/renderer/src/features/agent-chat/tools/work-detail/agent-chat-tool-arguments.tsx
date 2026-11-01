import { useMemo } from 'react';

import { writeToClipboardWithFeedback } from '../../../../components/copy-feedback';
import { CopyIconButton } from '../../../../components/markdown/copy-icon-button';
import { useTranslation } from '../../../../i18n';
import { textClipboard } from '../../../../lib/clipboard';
import { cn } from '../../../../lib/utilities';
import type { AgentChatToolArgumentEntry } from '../agent-chat-tool-argument-entries';
import { agentChatToolArgumentEntries } from '../agent-chat-tool-argument-entries';

/**
 * An expanded tool call's arguments. A JSON object reads as a name and value list, the way the Codex app sets a tool's
 * input apart from its result, instead of one run-on line of JSON; any other preview is shown as written.
 */
export function AgentChatToolArguments({ text }: { text: string }) {
    const { t } = useTranslation();
    const entries = useMemo(() => agentChatToolArgumentEntries(text), [text]);
    return (
        <div className="group/arguments relative">
            <div className="absolute top-0 right-0 opacity-0 transition-opacity duration-(--motion-feedback) group-focus-within/arguments:opacity-100 group-hover/arguments:opacity-100">
                <CopyIconButton
                    copy={() => writeToClipboardWithFeedback(textClipboard, text)}
                    label={t('agentChat.workGroup.copyArguments')}
                />
            </div>
            {entries ? <ArgumentList entries={entries} /> : <ArgumentText text={text} />}
        </div>
    );
}

function ArgumentText({ text }: { text: string }) {
    return (
        <p className="m-0 pr-7 font-mono text-[11px] wrap-anywhere whitespace-pre-wrap text-muted select-text">
            {text}
        </p>
    );
}

function ArgumentList({ entries }: { entries: AgentChatToolArgumentEntry[] }) {
    return (
        <dl className="m-0 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 pr-7 select-text">
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
