import { isChatTerminal } from '@caxri/protocol';
import { MessageSquarePlus, SquareTerminal } from 'lucide-react';
import type { editor as MonacoEditor } from 'monaco-editor';

import {
    SELECTION_TOOLBAR_BUTTON_CLASS_NAME,
    SelectionToolbar,
} from '../../components/selection-toolbar';
import { ShortcutBadge } from '../../components/shortcut-badge';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { useEditorSelectionToolbar } from './hooks/use-editor-selection-toolbar';
import { activeFileReferenceTarget, sendActiveFileReference } from './send-file-reference';

/**
 * Add to Chat (or Send to Terminal) for code selected in an editor, floating over the selection the way Cursor's and VS
 * Code Copilot's selection actions do, so the reference no longer depends on knowing `editor.sendReferenceToTerminal`'s
 * shortcut. It runs that same command: `@path#L<start>-L<end>` goes to the Session's most recently opened Agent Chat
 * draft or Terminal prompt, and the button is named after that target. Hidden when the Session has neither.
 */
export function EditorSelectionToolbar({
    editor,
}: {
    editor: MonacoEditor.ICodeEditor | undefined;
}) {
    const { t } = useTranslation();
    const { dismiss, isShown, toolbarReference } = useEditorSelectionToolbar(editor);
    const shortcut = useCommandShortcut('editor.sendReferenceToTerminal');
    if (!isShown) return null;
    // Read when the toolbar appears: the target follows the Session's Terminals, not the editor's selection.
    const target = activeFileReferenceTarget();
    if (!target) return null;
    const isChat = isChatTerminal(target);
    const Icon = isChat ? MessageSquarePlus : SquareTerminal;
    return (
        <SelectionToolbar
            label={t('editor.selectionToolbar.label')}
            toolbarReference={toolbarReference}
        >
            <button
                className={SELECTION_TOOLBAR_BUTTON_CLASS_NAME}
                type="button"
                onClick={async () => {
                    dismiss();
                    await sendActiveFileReference();
                }}
            >
                <Icon className="size-3.5" />
                {t(
                    isChat
                        ? 'editor.selectionToolbar.addToChat'
                        : 'editor.selectionToolbar.sendToTerminal',
                )}
                {shortcut && <ShortcutBadge compact className="ml-1" shortcut={shortcut} />}
            </button>
        </SelectionToolbar>
    );
}
