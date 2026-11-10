import { editorModelPath } from '@desktop-shared/editor-state';
import type { editor as Monaco } from 'monaco-editor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeMonaco = vi.hoisted(() => {
    const models = new Map<string, { dispose: () => void; uri: { toString: () => string } }>();
    const attached = new Set<string>();
    return {
        attached,
        models,
        monaco: {
            Uri: { parse: (value: string) => ({ toString: () => value }) },
            editor: {
                getEditors: () => [...attached].map((uri) => ({ getModel: () => models.get(uri) })),
                getModel: (uri: { toString: () => string }) => models.get(uri.toString()),
            },
        },
    };
});

vi.mock('../../../lib/caxri', () => ({ caxri: { request: vi.fn(), onEvent: vi.fn() } }));
vi.mock('../../../lib/monaco', () => ({ monaco: fakeMonaco.monaco }));

import { useSessionViewStore } from '../../../stores/session-view';
import {
    retainEditorModel,
    scheduleEditorModelRelease,
    synchronizeControlledEditorModel,
} from '../editor-model-sync';

const path = '/project/sample.ts';
const uri = editorModelPath('session-1', path);

function addModel(modelUri: string): ReturnType<typeof vi.fn> {
    const dispose = vi.fn(() => fakeMonaco.models.delete(modelUri));
    fakeMonaco.models.set(modelUri, { dispose, uri: { toString: () => modelUri } });
    return dispose;
}

function cacheDocument(): void {
    useSessionViewStore.getState().cacheDocument('session-1', {
        path,
        content: 'export const value = 1;',
        dirty: false,
        mtimeMs: 1,
        size: 23,
    });
}

describe('editor model retention', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        fakeMonaco.models.clear();
        fakeMonaco.attached.clear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the model, and its undo history, while the editor is unmounted but the document stays open', () => {
        cacheDocument();
        const dispose = addModel(uri);
        retainEditorModel(uri);

        // The pane switched to a Chat tab: no widget holds the model any more.
        scheduleEditorModelRelease();
        vi.runAllTimers();

        expect(dispose).not.toHaveBeenCalled();
    });

    it('releases the model once its document leaves the cache and no editor shows it', () => {
        cacheDocument();
        const dispose = addModel(uri);
        retainEditorModel(uri);

        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        vi.runAllTimers();

        expect(dispose).toHaveBeenCalledOnce();
    });

    it('waits for the widget to let go before releasing a closed document it still shows', () => {
        cacheDocument();
        const dispose = addModel(uri);
        retainEditorModel(uri);
        fakeMonaco.attached.add(uri);

        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        vi.runAllTimers();
        expect(dispose).not.toHaveBeenCalled();

        fakeMonaco.attached.delete(uri);
        scheduleEditorModelRelease();
        vi.runAllTimers();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('never touches a model the file editor did not retain', () => {
        const dispose = addModel('caxri://agent-transcript/terminal-1.jsonl');

        scheduleEditorModelRelease();
        vi.runAllTimers();

        expect(dispose).not.toHaveBeenCalled();
    });
});

function createEditor(uri: string, initialValue: string) {
    let value = initialValue;
    const model = {
        getFullModelRange: () => ({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: value.length + 1,
        }),
        getValue: () => value,
        uri: { toString: () => uri },
    };
    const executeEdits = vi.fn((_source: string, edits: Array<{ text: string }>) => {
        value = edits[0]?.text ?? '';
        return true;
    });
    const pushUndoStop = vi.fn(() => true);
    return {
        editor: {
            executeEdits,
            getModel: () => model,
            pushUndoStop,
        } as unknown as Monaco.IStandaloneCodeEditor,
        executeEdits,
        getValue: () => value,
        pushUndoStop,
    };
}

describe('synchronizeControlledEditorModel', () => {
    it('leaves a different URI and an already-current model unchanged', () => {
        const different = createEditor('caxri://session/one/different.txt', 'stale');
        const current = createEditor('caxri://session/one/current.txt', 'current');

        synchronizeControlledEditorModel(
            different.editor,
            'caxri://session/one/current.txt',
            'current',
            { current: false },
        );
        synchronizeControlledEditorModel(
            current.editor,
            'caxri://session/one/current.txt',
            'current',
            { current: false },
        );

        expect(different.executeEdits).not.toHaveBeenCalled();
        expect(current.executeEdits).not.toHaveBeenCalled();
        expect(different.pushUndoStop).not.toHaveBeenCalled();
        expect(current.pushUndoStop).not.toHaveBeenCalled();
    });

    it('suppresses only the controlled write and keeps its undo boundary', () => {
        const fixture = createEditor('caxri://session/one/alias.txt', 'stale');
        const programmaticChange = { current: false };
        let forwardedChanges = 0;
        const applyEdits = fixture.executeEdits.getMockImplementation()!;
        fixture.executeEdits.mockImplementation((_source, edits) => {
            if (!programmaticChange.current) forwardedChanges += 1;
            return applyEdits(_source, edits);
        });

        synchronizeControlledEditorModel(
            fixture.editor,
            'caxri://session/one/alias.txt',
            'replacement',
            programmaticChange,
        );

        expect(fixture.executeEdits).toHaveBeenCalledOnce();
        expect(fixture.pushUndoStop).toHaveBeenCalledOnce();
        expect(fixture.getValue()).toBe('replacement');
        expect(forwardedChanges).toBe(0);
        expect(programmaticChange.current).toBe(false);
    });

    it('restores change forwarding when Monaco rejects the controlled write', () => {
        const fixture = createEditor('caxri://session/one/alias.txt', 'stale');
        const programmaticChange = { current: false };
        fixture.executeEdits.mockImplementation(() => {
            expect(programmaticChange.current).toBe(true);
            throw new Error('fixture write failed');
        });

        expect(() =>
            synchronizeControlledEditorModel(
                fixture.editor,
                'caxri://session/one/alias.txt',
                'replacement',
                programmaticChange,
            ),
        ).toThrow('fixture write failed');
        expect(programmaticChange.current).toBe(false);
        expect(fixture.pushUndoStop).not.toHaveBeenCalled();
    });
});
