import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UnsavedEditorsDecisionOptions, UnsavedEditorsSummary } from '../unsaved-editors';
import {
    createUnsavedEditorsBridge,
    decideUnsavedEditors,
    unsavedEditorsPrompt,
} from '../unsaved-editors';

const twoFiles: UnsavedEditorsSummary = {
    kind: 'summary',
    count: 2,
    names: ['a.ts', 'b.ts'],
};

function decision(
    overrides: Partial<UnsavedEditorsDecisionOptions> = {},
): UnsavedEditorsDecisionOptions {
    return {
        confirm: vi.fn().mockResolvedValue('save'),
        inspect: vi.fn().mockResolvedValue(twoFiles),
        log: vi.fn(),
        reveal: vi.fn(),
        saveAll: vi.fn().mockResolvedValue({ kind: 'saved' }),
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('decideUnsavedEditors', () => {
    it('continues without prompting when nothing is unsaved', async () => {
        const target = decision({
            inspect: vi.fn().mockResolvedValue({ kind: 'summary', count: 0, names: [] }),
        });

        await expect(decideUnsavedEditors(target)).resolves.toBe('continue');

        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.log).not.toHaveBeenCalled();
    });

    it('saves every buffer before continuing on Save All', async () => {
        const target = decision();

        await expect(decideUnsavedEditors(target)).resolves.toBe('continue');

        expect(target.saveAll).toHaveBeenCalledOnce();
        expect(target.log).toHaveBeenCalledWith('saved', 2);
    });

    it('stays open when a save fails', async () => {
        const target = decision({
            saveAll: vi.fn().mockResolvedValue({ kind: 'saveFailed', reason: 'writeFailed' }),
        });

        await expect(decideUnsavedEditors(target)).resolves.toBe('cancel');

        expect(target.log).toHaveBeenCalledWith('saveFailed', 2, 'writeFailed');
        expect(target.reveal).not.toHaveBeenCalled();
    });

    it('stays open when the save request itself fails', async () => {
        const target = decision({ saveAll: vi.fn().mockRejectedValue(new Error('timed out')) });

        await expect(decideUnsavedEditors(target)).resolves.toBe('cancel');

        expect(target.log).toHaveBeenCalledWith('saveFailed', 2, 'timed out');
    });

    it("continues without saving on Don't Save", async () => {
        const target = decision({ confirm: vi.fn().mockResolvedValue('discard') });

        await expect(decideUnsavedEditors(target)).resolves.toBe('continue');

        expect(target.saveAll).not.toHaveBeenCalled();
        expect(target.log).toHaveBeenCalledWith('discarded', 2);
    });

    it('cancels and reveals the first unsaved buffer on Cancel', async () => {
        const target = decision({ confirm: vi.fn().mockResolvedValue('cancel') });

        await expect(decideUnsavedEditors(target)).resolves.toBe('cancel');

        expect(target.reveal).toHaveBeenCalledOnce();
        expect(target.saveAll).not.toHaveBeenCalled();
    });

    it('fails open when the Workbench cannot be asked', async () => {
        const target = decision({ inspect: vi.fn().mockRejectedValue(new Error('no answer')) });

        await expect(decideUnsavedEditors(target)).resolves.toBe('continue');

        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.log).toHaveBeenCalledWith('readFailed', 0, 'no answer');
    });
});

describe('unsavedEditorsPrompt', () => {
    it('names a single file and offers Save', () => {
        const prompt = unsavedEditorsPrompt(
            { kind: 'summary', count: 1, names: ['greeting.ts'] },
            'quit',
        );

        expect(prompt.message).toBe("Save changes to 'greeting.ts' before quitting?");
        expect(prompt.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
        expect(prompt).toMatchObject({ defaultId: 0, cancelId: 2 });
    });

    it('counts several files, lists the first names, and offers Save All', () => {
        const prompt = unsavedEditorsPrompt(
            { kind: 'summary', count: 5, names: ['a.ts', 'b.ts', 'c.ts'] },
            'close',
        );

        expect(prompt.message).toBe('Save changes to 5 files before closing the window?');
        expect(prompt.detail).toBe(
            "a.ts\nb.ts\nc.ts\nand 2 more\n\nYour changes will be lost if you don't save them.",
        );
        expect(prompt.buttons).toEqual(['Save All', "Don't Save", 'Cancel']);
    });
});

describe('createUnsavedEditorsBridge', () => {
    it('resolves inspect with the matching reply', async () => {
        const send = vi.fn(() => true);
        const bridge = createUnsavedEditorsBridge({ send, createRequestId: () => 'request-1' });

        const pending = bridge.inspect();
        expect(send).toHaveBeenCalledWith({ requestId: 'request-1', action: 'inspect' });
        bridge.reply({ requestId: 'other', reply: { kind: 'saved' } });
        bridge.reply({ requestId: 'request-1', reply: twoFiles });

        await expect(pending).resolves.toEqual(twoFiles);
    });

    it('reports nothing unsaved when no Workbench window exists', async () => {
        const bridge = createUnsavedEditorsBridge({ send: () => false });

        await expect(bridge.inspect()).resolves.toEqual({ kind: 'summary', count: 0, names: [] });
    });

    it('rejects a request the Workbench never answers', async () => {
        vi.useFakeTimers();
        const bridge = createUnsavedEditorsBridge({ send: () => true, inspectTimeoutMs: 10 });

        const pending = bridge.inspect();
        const assertion = expect(pending).rejects.toThrow('Workbench did not answer inspect');
        await vi.advanceTimersByTimeAsync(10);
        await assertion;
    });
});
