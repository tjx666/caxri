import type { DragEvent, RefObject } from 'react';
import { useImperativeHandle } from 'react';

import type { AgentChatPathReference, TerminalRecord } from '@caxri/protocol';
import { agentChatImageToken } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { isOsFileDrag, isOsFileReferenceRefused, osFilePaths } from '../../../lib/file-drag';
import { pushToast } from '../../../stores/toasts';
import { terminalDropInput } from '../../terminal/terminal-drop';
import type { AgentChatComposerInput } from '../agent-chat-composer-view';
import { draftWithInsertion } from '../agent-chat-drafts';
import { agentChatOsFileReferences } from '../agent-chat-path-attachments';
import type { useAgentChatAttachments } from './use-agent-chat-attachments';
import type { AgentChatDropHandlers } from './use-agent-chat-file-input';
import { useAgentChatFileInput } from './use-agent-chat-file-input';
import type { AgentChatPasteRange } from './use-agent-chat-long-paste';
import { useAgentChatLongPaste } from './use-agent-chat-long-paste';

/**
 * Everything that puts content into the composer besides typing: pasted, dropped, and picked files (images attach,
 * other files and folders from another application become cards the message cites by path, and Caxri's own Files,
 * Editor tab, and Project drags are cited in the text), long pastes saved to a file, and Cmd+Shift+V's plain-text
 * paste. Returns the file input handlers, the plain-text paste, and whether picked images are still being read or a
 * long paste saved, which holds Send.
 */
export function useAgentChatComposerInput({
    draft,
    dropHandlersReference,
    images,
    inputReference,
    providerName,
    reserveImageTokens,
    setDraft,
    supportsImages,
    terminal,
    terminalId,
    workbenchRoot,
}: {
    draft: string;
    dropHandlersReference: RefObject<AgentChatDropHandlers | null>;
    images: Pick<
        ReturnType<typeof useAgentChatAttachments>,
        'add' | 'addPaths' | 'addPathsWhenResolved' | 'isReading'
    >;
    inputReference: RefObject<AgentChatComposerInput | null>;
    providerName: string;
    /**
     * The first of `count` placeholder numbers for images about to be attached (`useAgentChatImagePlaceholders`).
     */
    reserveImageTokens: (count: number) => number;
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
        const input = inputReference.current;
        const current = input?.value ?? draft;
        const start = input?.selectionStart ?? current.length;
        const at = range?.value === current ? range : { start, end: input?.selectionEnd ?? start };
        const inserted = draftWithInsertion(current, at.start, at.end, text);
        setDraft(() => inserted.draft);
        requestAnimationFrame(() => {
            input?.focus();
            input?.setSelectionRange(inserted.caret, inserted.caret);
        });
    };
    /**
     * Cites what a drop or pick carries besides the images it attached. Files and folders from another application
     * (Finder, a file picker, or a paste) become cards, as in the Codex app; a Files entry, an Editor tab, or a Project
     * is cited at the caret by path relative to where the Agent runs, the way a drop into a Terminal pastes one,
     * because the user drags those into the sentence they are writing. Returns whether it cited anything.
     */
    const didInsertPaths = (event: DragEvent | undefined, files: readonly File[]): boolean => {
        if (event && !isOsFileDrag(event.dataTransfer)) {
            const input = terminal && terminalDropInput(event, terminal, workbenchRoot, files);
            if (input) insertText(input);
            return Boolean(input);
        }
        if (files.length === 0) return false;
        if (osFilePaths(files).length === 0) {
            pushToast(
                'warning',
                translate(
                    isOsFileReferenceRefused()
                        ? 'agentChat.composer.localFileOnSshHost'
                        : 'agentChat.composer.fileHasNoPath',
                ),
            );
            return false;
        }
        // The card is reserved now: the folder probe holds Send until the card is attached.
        // eslint-disable-next-line no-void -- addPathsWhenResolved reports nothing to wait for
        void images.addPathsWhenResolved(agentChatOsFileReferences(files));
        return true;
    };
    /**
     * Files and folders picked in the native panel, as cards. Returns whether it attached anything.
     */
    const didInsertPickedPaths = (references: readonly AgentChatPathReference[]): boolean =>
        images.addPaths(references).length > 0;
    const longPaste = useAgentChatLongPaste({
        insert: insertText,
        inputReference,
        setDraft,
        terminalId,
    });
    /**
     * Attaches images and writes their `[Image #N]` placeholders at the caret once they are read, as the terminal
     * Agents do for a pasted image, so the message says where each one belongs.
     */
    const addImages = async (files: readonly File[]): Promise<void> => {
        const tokens = await images.add(files, reserveImageTokens(files.length));
        if (tokens.length > 0) insertText(tokens.map(agentChatImageToken).join(' '));
    };
    const fileInput = useAgentChatFileInput({
        add: addImages,
        didInsertPaths,
        didInsertPickedPaths,
        isImageInputEnabled: supportsImages,
        providerName,
        takeLongPaste: longPaste.didTakePaste,
    });
    useImperativeHandle(dropHandlersReference, () => fileInput.dropHandlers);
    return {
        fileInput,
        isAttaching: images.isReading || longPaste.isSaving,
        pastePlainText: longPaste.pastePlainText,
    };
}
