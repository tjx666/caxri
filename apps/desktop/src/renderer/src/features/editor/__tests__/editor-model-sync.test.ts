import type { editor as Monaco } from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';

import { synchronizeControlledEditorModel } from '../editor-model-sync';

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
