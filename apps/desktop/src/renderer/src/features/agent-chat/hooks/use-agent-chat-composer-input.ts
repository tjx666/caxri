import type { DragEvent, RefObject } from 'react';
import { useImperativeHandle } from 'react';

import type { TerminalRecord } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { isOsFileReferenceRefused } from '../../../lib/file-drag';
import { pushToast } from '../../../stores/toasts';
import {
    terminalDropInput,
    terminalFilesInput,
    terminalPathsInput,
} from '../../terminal/terminal-drop';
import { draftWithInsertion } from '../agent-chat-drafts';
import type { useAgentChatAttachments } from './use-agent-chat-attachments';
import type { AgentChatDropHandlers } from './use-agent-chat-file-input';
import { useAgentChatFileInput } from './use-agent-chat-file-input';
import type { AgentChatPasteRange } from './use-agent-chat-long-paste';
import { useAgentChatLongPaste } from './use-agent-chat-long-paste';

/**
 * Everything that puts content into the composer besides typing: pasted, dropped, and picked files (images attach,
 * other files are cited by path) and long pastes saved to a file. Returns the file input handlers and whether picked
 * images are still being read or a long paste saved, which holds Send.
 */
export function useAgentChatComposerInput({
    draft,
    dropHandlersReference,
    images,
    inputReference,
    providerName,
    setDraft,
    supportsImages,
    terminal,
    terminalId,
    workbenchRoot,
}: {
    draft: string;
    dropHandlersReference: RefObject<AgentChatDropHandlers | null>;
    images: Pick<ReturnType<typeof useAgentChatAttachments>, 'add' | 'isReading'>;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    providerName: string;
    setDraft: (update: (current: string) => string) => void;
    supportsImages: boolean;
    terminal: TerminalRecord | undefined;
    terminalId: string;
    workbenchRoot: string | undefined;
}) {
    /**
     * Inserts `text` over `range` while the input still holds the text the range was taken from, and at the caret
     * otherwise (the user kept typing while a long paste was saved), then puts the caret after it.
     */
    const insertText = (text: string, range?: AgentChatPasteRange): void => {
        const textarea = inputReference.current;
        const current = textarea?.value ?? draft;
        const start = textarea?.selectionStart ?? current.length;
        const at =
            range?.value === current ? range : { start, end: textarea?.selectionEnd ?? start };
        const inserted = draftWithInsertion(current, at.start, at.end, text);
        setDraft(() => inserted.draft);
        requestAnimationFrame(() => {
            textarea?.focus();
            textarea?.setSelectionRange(inserted.caret, inserted.caret);
        });
    };
    /**
     * A dropped or picked file is cited by path the way a drop into a Terminal pastes one, relative to where the Agent
     * runs, and lands at the caret. Returns whether it inserted anything.
     */
    const didInsertPaths = (event: DragEvent | undefined, files: readonly File[]): boolean => {
        const input =
            terminal &&
            (event
                ? terminalDropInput(event, terminal, workbenchRoot, files)
                : terminalFilesInput(files, terminal, workbenchRoot));
        if (input) {
            insertText(input);
            return true;
        }
        if (files.length > 0)
            pushToast(
                'warning',
                translate(
                    isOsFileReferenceRefused()
                        ? 'agentChat.composer.localFileOnSshHost'
                        : 'agentChat.composer.fileHasNoPath',
                ),
            );
        return false;
    };
    /**
     * Paths picked in the native panel, files and folders alike, cited the same way. Returns whether it inserted
     * anything.
     */
    const didInsertPickedPaths = (paths: readonly string[]): boolean => {
        const input = terminal && terminalPathsInput(paths, terminal, workbenchRoot);
        if (input) insertText(input);
        return Boolean(input);
    };
    const longPaste = useAgentChatLongPaste({ insert: insertText, terminalId });
    const fileInput = useAgentChatFileInput({
        add: images.add,
        didInsertPaths,
        didInsertPickedPaths,
        isImageInputEnabled: supportsImages,
        providerName,
        takeLongPaste: longPaste.didTakePaste,
    });
    useImperativeHandle(dropHandlersReference, () => fileInput.dropHandlers);
    return { fileInput, isAttaching: images.isReading || longPaste.isSaving };
}
