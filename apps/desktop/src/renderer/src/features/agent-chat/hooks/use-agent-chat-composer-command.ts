import { useEffect, useRef, useState } from 'react';

import { useLatestReference } from '@/hooks/use-latest-reference';

import type { AgentChatComposerCommand } from '../agent-chat-composer-commands';
import {
    agentChatCommandFinalFocus,
    registerAgentChatComposerCommand,
} from '../agent-chat-composer-commands';

/**
 * Registers `run` as this Chat's handler for `command` while `isAvailable`, so the command's shortcut and palette entry
 * reach the control only while it renders.
 */
export function useAgentChatComposerCommand(
    terminalId: string,
    command: AgentChatComposerCommand,
    isAvailable: boolean,
    run: () => void,
): void {
    const latestRun = useLatestReference(run);
    useEffect(() => {
        if (!isAvailable) return;
        return registerAgentChatComposerCommand(terminalId, command, () => latestRun.current());
    }, [command, isAvailable, latestRun, terminalId]);
}

/**
 * A composer menu's open state, also opened by `command`. A command-opened menu returns focus to what had it when the
 * command ran, normally the composer's input, rather than to the trigger it never touched; a click-opened one keeps the
 * trigger.
 */
export function useAgentChatComposerMenu(
    terminalId: string,
    command: AgentChatComposerCommand,
    isAvailable: boolean,
    onOpen?: () => void,
): {
    finalFocus: () => HTMLElement | true;
    isOpen: boolean;
    /**
     * Whether the command, not the trigger, opened the menu that is open now.
     */
    isOpenedByCommand: () => boolean;
    setOpen: (isOpen: boolean) => void;
} {
    const [isOpen, setIsOpen] = useState(false);
    const focusedWhenRun = useRef<Element | null>(null);
    useAgentChatComposerCommand(terminalId, command, isAvailable, () => {
        focusedWhenRun.current = document.activeElement;
        onOpen?.();
        setIsOpen(true);
    });
    return {
        finalFocus: () => agentChatCommandFinalFocus(focusedWhenRun.current),
        isOpen,
        isOpenedByCommand: () => focusedWhenRun.current !== null,
        setOpen: (open) => {
            // A click or a key on the trigger opens it again: return to the trigger, not an older command's target.
            if (open) focusedWhenRun.current = null;
            setIsOpen(open);
        },
    };
}
