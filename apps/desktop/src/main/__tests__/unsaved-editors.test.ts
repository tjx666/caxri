import { afterEach, describe, expect, it, vi } from 'vitest';

import { setMainLanguage } from '../locale';
import type { UnsavedEditorsDecisionOptions, UnsavedEditorsSummary } from '../unsaved-editors';
import {
    createUnsavedEditorsBridge,
    createWorkbenchUnsavedEditors,
    decideUnsavedEditors,
    unsavedEditorsPrompt,
} from '../unsaved-editors';

const twoFiles: UnsavedEditorsSummary = {
    kind: 'summary',
    count: 2,
    names: ['a.ts', 'b.ts'],
    autoSave: false,
};

function decision(
    overrides: Partial<UnsavedEditorsDecisionOptions> = {},
): UnsavedEditorsDecisionOptions {
    return {
        confirm: vi.fn().mockResolvedValue('save'),
        discardAll: vi.fn().mockResolvedValue(undefined),
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
            inspect: vi
                .fn()
                .mockResolvedValue({ kind: 'summary', count: 0, names: [], autoSave: false }),
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
        expect(target.discardAll).toHaveBeenCalledOnce();
        expect(target.log).toHaveBeenCalledWith('discarded', 2);
    });

    it("still continues on Don't Save when the backups could not be dropped", async () => {
        const target = decision({
            confirm: vi.fn().mockResolvedValue('discard'),
            discardAll: vi.fn().mockRejectedValue(new Error('timed out')),
        });

        await expect(decideUnsavedEditors(target)).resolves.toBe('continue');
    });

    it('cancels and reveals the first unsaved buffer on Cancel', async () => {
        const target = decision({ confirm: vi.fn().mockResolvedValue('cancel') });

        await expect(decideUnsavedEditors(target)).resolves.toBe('cancel');

        expect(target.reveal).toHaveBeenCalledOnce();
        expect(target.saveAll).not.toHaveBeenCalled();
    });

    it('saves under auto save without prompting', async () => {
        const target = decision({
            inspect: vi.fn().mockResolvedValue({ ...twoFiles, autoSave: true }),
        });

        await expect(decideUnsavedEditors(target)).resolves.toBe('continue');

        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.saveAll).toHaveBeenCalledOnce();
        expect(target.log).toHaveBeenCalledWith('autoSaved', 2);
    });

    it('prompts for what auto save could not write', async () => {
        const target = decision({
            inspect: vi
                .fn()
                .mockResolvedValueOnce({ ...twoFiles, autoSave: true })
                .mockResolvedValueOnce({
                    kind: 'summary',
                    count: 1,
                    names: ['b.ts'],
                    autoSave: true,
                }),
            saveAll: vi
                .fn()
                .mockResolvedValueOnce({ kind: 'saveFailed', reason: 'writeFailed' })
                .mockResolvedValueOnce({ kind: 'saved' }),
        });

        await expect(decideUnsavedEditors(target)).resolves.toBe('continue');

        expect(target.log).toHaveBeenCalledWith('saveFailed', 2, 'writeFailed');
        expect(target.confirm).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
        expect(target.log).toHaveBeenCalledWith('saved', 1);
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
            { kind: 'summary', count: 1, names: ['greeting.ts'], autoSave: false },
            'quit',
        );

        expect(prompt.message).toBe("Save changes to 'greeting.ts' before quitting?");
        expect(prompt.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
        expect(prompt).toMatchObject({ defaultId: 0, cancelId: 2 });
    });

    it('counts several files, lists the first names, and offers Save All', () => {
        const prompt = unsavedEditorsPrompt(
            { kind: 'summary', count: 5, names: ['a.ts', 'b.ts', 'c.ts'], autoSave: false },
            'close',
        );

        expect(prompt.message).toBe('Save changes to 5 files before closing the window?');
        expect(prompt.detail).toBe(
            "a.ts\nb.ts\nc.ts\nand 2 more\n\nYour changes will be lost if you don't save them.",
        );
        expect(prompt.buttons).toEqual(['Save All', "Don't Save", 'Cancel']);
    });

    it('speaks the workbench.language locale with no English left over', () => {
        setMainLanguage('zh-CN', []);
        try {
            const single = unsavedEditorsPrompt(
                { kind: 'summary', count: 1, names: ['greeting.ts'], autoSave: false },
                'quit',
            );
            const several = unsavedEditorsPrompt(
                { kind: 'summary', count: 5, names: ['a.ts', 'b.ts', 'c.ts'], autoSave: false },
                'close',
            );

            expect(single.message).toBe('退出前要保存对“greeting.ts”所做的更改吗？');
            expect(several.buttons).toEqual(['全部保存', '不保存', '取消']);
            for (const prompt of [single, several]) {
                const copy = [
                    prompt.title,
                    prompt.message,
                    prompt.detail,
                    ...(prompt.buttons ?? []),
                ]
                    .join('\n')
                    .replaceAll(/[a-c]\.ts|greeting\.ts/g, '');
                expect(copy).not.toMatch(/[A-Z]/i);
            }
        } finally {
            setMainLanguage(null, []);
        }
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

        await expect(bridge.inspect()).resolves.toEqual({
            kind: 'summary',
            count: 0,
            names: [],
            autoSave: false,
        });
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

describe('createWorkbenchUnsavedEditors', () => {
    function setup(counts: Record<string, number>) {
        const requests: Array<{ key: string; action: string }> = [];
        const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) };
        const windows = Object.keys(counts).map((key) => ({
            key,
            window: { isDestroyed: () => false } as never,
        }));
        const editors: ReturnType<typeof createWorkbenchUnsavedEditors> =
            createWorkbenchUnsavedEditors({
                dialog: dialog as never,
                logger: () => {},
                windows: () => windows,
                sendEvent: (event, key) => {
                    const { requestId, action } = event.payload;
                    requests.push({ key, action });
                    queueMicrotask(() =>
                        editors.reply({
                            requestId,
                            reply:
                                action === 'inspect'
                                    ? {
                                          kind: 'summary',
                                          count: counts[key] ?? 0,
                                          names: Array.from(
                                              { length: counts[key] ?? 0 },
                                              (_, index) => `${key}-${index}.ts`,
                                          ),
                                          autoSave: false,
                                      }
                                    : { kind: 'saved' },
                        }),
                    );
                },
            });
        return { dialog, editors, requests };
    }

    it('asks only the named window when one window closes', async () => {
        const { editors, requests } = setup({ 'main': 1, 'win-1': 2 });

        await expect(editors.decide('close', 'win-1')).resolves.toBe('continue');

        expect(requests.filter(({ action }) => action === 'inspect')).toEqual([
            { key: 'win-1', action: 'inspect' },
        ]);
    });

    it('merges every window into one prompt and saves only the dirty windows', async () => {
        const { dialog, editors, requests } = setup({ 'main': 0, 'win-1': 2, 'win-2': 1 });

        await expect(editors.decide('quit')).resolves.toBe('continue');

        expect(dialog.showMessageBox).toHaveBeenCalledOnce();
        expect(requests.filter(({ action }) => action === 'saveAll').map(({ key }) => key)).toEqual(
            ['win-1', 'win-2'],
        );
    });

    it('does not prompt when no window has unsaved buffers', async () => {
        const { dialog, editors } = setup({ 'main': 0, 'win-1': 0 });

        await expect(editors.decide('quit')).resolves.toBe('continue');

        expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });
});
