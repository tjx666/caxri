import type { RefObject } from 'react';
import { createElement, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, placeholder as placeholderExtension } from '@codemirror/view';
import { QueryClientProvider } from '@tanstack/react-query';

import { LinkFavicon } from '../../../components/markdown/link-favicon';
import { useTranslation } from '../../../i18n';
import { linkSummary } from '../../../lib/link-summary';
import { queryClient } from '../../../queries/client';
import { AgentChatVideoPlayerDialog } from '../attachments/agent-chat-message-videos';
import type { AgentChatPathPill } from '../attachments/agent-chat-path-pills';
import { agentChatKnownInvocations } from '../composer-input/chips/agent-chat-invocation-chips';
import type { useAgentChatCommandMenu } from '../hooks/use-agent-chat-command-menu';
import type { useAgentChatComposerEnter } from '../hooks/use-agent-chat-composer-enter';
import type { useAgentChatComposerSend } from '../hooks/use-agent-chat-composer-send';
import type { useAgentChatDraftStash } from '../hooks/use-agent-chat-draft-stash';
import type { useAgentChatImagePlaceholders } from '../hooks/use-agent-chat-image-placeholders';
import type { useAgentChatPromptHistory } from '../hooks/use-agent-chat-prompt-history';
import type { useAgentChatSessionMenu } from '../hooks/use-agent-chat-session-menu';
import type { AgentChatLinkIconMount } from './agent-chat-composer-extensions';
import {
    agentChatComposerExtensions,
    agentChatImagePills,
    agentChatLinkIcons,
    agentChatPathPills,
    externalDraft,
} from './agent-chat-composer-extensions';
import type {
    AgentChatComposerInput,
    AgentChatComposerKeyEvent,
    AgentChatComposerPasteEvent,
} from './agent-chat-composer-view';
import {
    agentChatComposerAttributes,
    agentChatComposerInput,
    agentChatComposerKeyEvent,
    agentChatComposerPasteEvent,
    agentChatDraftTransaction,
    isAgentChatEditorTextDrop,
} from './agent-chat-composer-view';

/**
 * The composer's link icon mount (`agentChatLinkIcons`): each link's slot gets its own React root rendering the
 * transcript's `LinkFavicon`, so a pasted pull request link shows the same state glyph and reads the same cached
 * reference preview as it will once sent. CodeMirror owns the slot's lifetime, so the root is separate from the
 * composer's tree and brings its own query provider.
 */
function agentChatComposerLinkIconMount(
    referenceTerminalId: string | undefined,
): AgentChatLinkIconMount {
    return (slot, url) => {
        const summary = linkSummary(url);
        if (!summary) return () => {};
        const root = createRoot(slot);
        const icon = createElement(LinkFavicon, {
            origin: new URL(url).origin,
            referenceTerminalId,
            summary,
        });
        root.render(createElement(QueryClientProvider, { client: queryClient }, icon));
        // CodeMirror destroys widgets inside a dispatch, which can run during a React commit (the draft effect); an
        // unmount there would be synchronous inside React's own work, so it waits for the next microtask.
        return () => queueMicrotask(() => root.unmount());
    };
}

type ComposerSend = ReturnType<typeof useAgentChatComposerSend>;

/**
 * What the editor's DOM and change events call; refreshed every render so the long-lived editor reaches current state.
 */
interface ComposerHandlers {
    onBlur: () => void;
    onChange: (input: AgentChatComposerInput) => void;
    onClick: (input: AgentChatComposerInput) => void;
    onFocus: () => void;
    onKeyDown: (event: AgentChatComposerKeyEvent) => void;
    onKeyUp: (event: AgentChatComposerKeyEvent) => void;
    onOpenImage: (token: number) => void;
    onPaste: (event: AgentChatComposerPasteEvent) => void;
    onSelect: (input: AgentChatComposerInput) => void;
}

/**
 * The composer's message input: a CodeMirror editor whose document is the draft's Markdown, rendered in place as the
 * user writes (`agentChatMarkdownMarks`), as in the Codex app's composer. Each key goes to the first owner that claims
 * it, in this order: the draft stash (Ctrl+S), the prompt history list, the slash-command menu, the `@` Sessions menu,
 * Goal mode, and finally Enter and Escape; a key an owner prevents never reaches the editor's own keymap. The history
 * list's highlighted prompt replaces the placeholder while it is open. An attached image's `[Image #N]` placeholder
 * shows as a pill (`imagePlaceholders.pills`); clicking one opens its preview, and `imagePlaceholders.onEdit` hears
 * every edit the user makes so a deleted pill takes its image along. A dropped Files entry's path shows as a pill with
 * its icon and name (`pathPills`); a video's pill shows its poster frame and plays it on click. A pasted URL takes the
 * accent color and its site icon, a pull request's tinted by its state, as it will in the sent message. Ctrl+C empties
 * the input (`composerKeys`).
 */
export function AgentChatComposerEditor({
    composerKeys,
    draft,
    goalMode,
    history,
    imagePlaceholders,
    inputReference,
    isEditing,
    knownInvocations,
    menu,
    menuActions,
    pathPills,
    placeholder,
    sessionMenu,
    setDraft,
    setInputFocused,
    stash,
    terminalId,
    onPaste,
}: {
    composerKeys: ReturnType<typeof useAgentChatComposerEnter>;
    draft: string;
    goalMode: ComposerSend['goalMode'];
    history: ReturnType<typeof useAgentChatPromptHistory>;
    imagePlaceholders: Pick<
        ReturnType<typeof useAgentChatImagePlaceholders>,
        'onEdit' | 'openImage' | 'pills'
    >;
    inputReference: RefObject<AgentChatComposerInput | null>;
    isEditing: boolean;
    /**
     * The `/command` and `$skill` spellings the menu offers, which the leading token is recognized against.
     */
    knownInvocations: ReadonlySet<string>;
    menu: ReturnType<typeof useAgentChatCommandMenu>;
    menuActions: Pick<ComposerSend, 'choose' | 'complete'>;
    /**
     * Paths dropped into the draft by token, drawn as pills (`useAgentChatComposerInput`).
     */
    pathPills: ReadonlyMap<string, AgentChatPathPill>;
    placeholder: string;
    sessionMenu: ReturnType<typeof useAgentChatSessionMenu>;
    setDraft: (update: (current: string) => string) => void;
    setInputFocused: (isFocused: boolean) => void;
    stash: ReturnType<typeof useAgentChatDraftStash>;
    /**
     * The Chat's Terminal, which scopes a pasted pull request link's state lookup. The composer sits outside the
     * timeline's `AgentChatTerminalContext`, so it arrives as a prop.
     */
    terminalId: string;
    onPaste: (event: AgentChatComposerPasteEvent) => void;
}) {
    const { t } = useTranslation();
    const imagePills = imagePlaceholders.pills;
    const hostReference = useRef<HTMLDivElement>(null);
    const viewReference = useRef<EditorView>(null);
    /**
     * The draft the editor starts with; it opens with the caret at 0, as a mounted textarea did, while a draft set
     * later moves the caret to the end (`agentChatDraftTransaction`).
     */
    const mountedDraft = useRef(draft);
    const handlers = useRef<ComposerHandlers>(null);
    /**
     * The video whose pill was clicked, playing in a dialog.
     */
    const [playingVideo, setPlayingVideo] = useState<string>();
    const [compartments] = useState(() => ({
        attributes: new Compartment(),
        imagePills: new Compartment(),
        invocations: new Compartment(),
        linkIcons: new Compartment(),
        pathPills: new Compartment(),
        placeholder: new Compartment(),
    }));
    const [{ attach, input }] = useState(agentChatComposerInput);
    useImperativeHandle(inputReference, () => input, [input]);
    const attributes = agentChatComposerAttributes({
        ...(history.inputAria ?? sessionMenu.inputAria ?? menu.inputAria),
        'aria-label': t('agentChat.composer.message'),
        // CodeMirror turns spellcheck off for code; the composer is prose, as the textarea was.
        'spellcheck': 'true',
    });
    const attributesKey = JSON.stringify(attributes);
    const shownPlaceholder = history.preview ?? placeholder;

    useLayoutEffect(() => {
        handlers.current = {
            onBlur: () => {
                setInputFocused(false);
                history.close();
            },
            onChange: (input) => {
                const { value } = input;
                setDraft(() => value);
                imagePlaceholders.onEdit(value);
                history.close();
                sessionMenu.trackCaret(input);
            },
            onClick: (input) => sessionMenu.trackCaret(input),
            onFocus: () => setInputFocused(true),
            onKeyDown: (event) => {
                sessionMenu.notePressedKey(event);
                // "Edit from here" owns the input; stashing it would strand the edit bar without its text, so the
                // hook refuses the key with a notice while editing.
                if (stash.didHandleKey(event, isEditing)) return;
                if (history.didHandleKey(event, menu.isOpen || sessionMenu.isOpen)) return;
                if (menu.didHandleKey(event, menuActions)) return;
                if (sessionMenu.didHandleKey(event)) return;
                if (goalMode.didHandleKey(event)) return;
                composerKeys.onKeyDown(event);
            },
            onKeyUp: sessionMenu.trackCaretKey,
            onOpenImage: imagePlaceholders.openImage,
            onPaste,
            onSelect: (input) => sessionMenu.followSelection(input),
        };
    });

    useLayoutEffect(() => {
        const parent = hostReference.current;
        if (!parent) return;
        // Ahead of the editor's keymap, so a key owner sees Enter before it inserts a newline.
        const domEvents = Prec.highest(
            EditorView.domEventHandlers({
                blur: () => handlers.current?.onBlur(),
                click: () => handlers.current?.onClick(input),
                focus: () => handlers.current?.onFocus(),
                keydown: (event) => {
                    handlers.current?.onKeyDown(agentChatComposerKeyEvent(event, input));
                    return event.defaultPrevented;
                },
                keyup: (event) =>
                    handlers.current?.onKeyUp(agentChatComposerKeyEvent(event, input)),
                paste: (event) => {
                    const pasted = agentChatComposerPasteEvent(event, input);
                    if (pasted) handlers.current?.onPaste(pasted);
                    return event.defaultPrevented;
                },
                // Files, Editor tabs, and Projects bubble to the pane's drop handlers, which cite them.
                dragover: (event) => !isAgentChatEditorTextDrop(event.dataTransfer),
                drop: (event) => !isAgentChatEditorTextDrop(event.dataTransfer),
            }),
        );
        const view = new EditorView({
            parent,
            state: EditorState.create({
                doc: mountedDraft.current,
                extensions: [
                    agentChatComposerExtensions(MAX_AGENT_CHAT_MESSAGE_LENGTH),
                    compartments.placeholder.of([]),
                    compartments.attributes.of([]),
                    compartments.imagePills.of([]),
                    compartments.invocations.of([]),
                    compartments.pathPills.of([]),
                    compartments.linkIcons.of([]),
                    EditorView.updateListener.of((update) => {
                        if (update.transactions.some((tr) => tr.annotation(externalDraft))) return;
                        if (update.docChanged) handlers.current?.onChange(input);
                        else if (update.selectionSet) handlers.current?.onSelect(input);
                    }),
                    domEvents,
                ],
            }),
        });
        // The draft as `value`, for the approval keys' empty check and for Playwright, since the DOM text omits the
        // Markdown syntax the live preview hides (`e2e/support/agent-chat-composer.ts`). The caret is not exposed as
        // `selectionStart`: React's selection restore treats an element carrying it as a textarea and assigns to it.
        Object.defineProperties(view.contentDOM, {
            composerSelection: {
                get: () => ({ end: input.selectionEnd, start: input.selectionStart }),
            },
            value: { get: () => input.value },
        });
        viewReference.current = view;
        attach(view);
        return () => {
            attach(null);
            viewReference.current = null;
            view.destroy();
        };
    }, [attach, compartments, input]);

    useLayoutEffect(() => {
        const view = viewReference.current;
        if (!view) return;
        const transaction = agentChatDraftTransaction(view.state.doc.toString(), draft);
        if (!transaction) return;
        view.dispatch({
            ...transaction,
            annotations: [externalDraft.of(true), ...[transaction.annotations ?? []].flat()],
        });
    }, [draft]);

    useLayoutEffect(() => {
        viewReference.current?.dispatch({
            effects: compartments.placeholder.reconfigure(placeholderExtension(shownPlaceholder)),
        });
    }, [compartments, shownPlaceholder]);

    useLayoutEffect(() => {
        const contentAttributes = JSON.parse(attributesKey) as Record<string, string>;
        const effects = compartments.attributes.reconfigure(
            EditorView.contentAttributes.of(contentAttributes),
        );
        viewReference.current?.dispatch({ effects });
    }, [attributesKey, compartments]);

    useLayoutEffect(() => {
        const pills = new Map(imagePills.map((pill) => [pill.token, pill]));
        const effects = compartments.imagePills.reconfigure(
            agentChatImagePills.of({
                pills,
                open: (token) => handlers.current?.onOpenImage(token),
            }),
        );
        viewReference.current?.dispatch({ effects });
    }, [compartments, imagePills]);

    useLayoutEffect(() => {
        const effects = compartments.invocations.reconfigure(
            agentChatKnownInvocations.of(knownInvocations),
        );
        viewReference.current?.dispatch({ effects });
    }, [compartments, knownInvocations]);

    useLayoutEffect(() => {
        const effects = compartments.pathPills.reconfigure(
            agentChatPathPills.of({ pills: pathPills, openVideo: setPlayingVideo }),
        );
        viewReference.current?.dispatch({ effects });
    }, [compartments, pathPills]);

    useLayoutEffect(() => {
        const effects = compartments.linkIcons.reconfigure(
            agentChatLinkIcons.of(agentChatComposerLinkIconMount(terminalId)),
        );
        viewReference.current?.dispatch({ effects });
    }, [compartments, terminalId]);

    return (
        <>
            <div ref={hostReference} data-slot="agent-chat-composer-editor" />
            <AgentChatVideoPlayerDialog
                path={playingVideo}
                onClose={() => setPlayingVideo(undefined)}
            />
        </>
    );
}
