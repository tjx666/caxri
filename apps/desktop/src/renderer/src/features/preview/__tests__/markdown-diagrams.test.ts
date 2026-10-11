import { draculaTheme } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const render = vi.fn<(id: string, source: string) => Promise<{ svg: string }>>();
const initialize = vi.fn<(config: { themeVariables?: Record<string, string> }) => void>();
vi.mock('mermaid', () => ({ default: { initialize, render } }));

class DiagramElement {
    html = '';

    set innerHTML(value: string) {
        this.html = value;
    }

    getHTML(): string {
        return this.html;
    }
}

async function fixture(count: number) {
    vi.resetModules();
    vi.stubGlobal('HTMLElement', DiagramElement);
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const elements = Array.from({ length: count }, () => new DiagramElement());
    const diagrams = elements.map((_, index) => ({
        id: `diagram-${index}`,
        source: `graph LR; A${index}-->B${index}`,
    }));
    const bySelector = new Map(
        elements.map((element, index) => [`[data-caxri-diagram="diagram-${index}"]`, element]),
    );
    const container = {
        querySelector: (selector: string) => bySelector.get(selector),
    } as unknown as HTMLElement;
    const { renderDiagrams } = await import('../markdown-diagrams');
    return { container, diagrams, elements, renderDiagrams };
}

afterEach(() => {
    vi.unstubAllGlobals();
    render.mockReset();
    initialize.mockReset();
});

describe('Markdown diagram scheduling', () => {
    it('runs only one layout at a time for an illustrated document', async () => {
        const release = Promise.withResolvers<void>();
        let active = 0;
        let peak = 0;
        render.mockImplementation(async (_id, source) => {
            active += 1;
            peak = Math.max(peak, active);
            await release.promise;
            active -= 1;
            return { svg: `<svg>${source}</svg>` };
        });
        const { container, diagrams, elements, renderDiagrams } = await fixture(12);
        const completed = renderDiagrams(
            container,
            diagrams,
            draculaTheme,
            new AbortController().signal,
        );
        try {
            await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
            expect(peak).toBe(1);
        } finally {
            release.resolve();
            await completed;
            expect(elements.every((element) => element.getHTML().length > 0)).toBe(true);
        }
        expect(peak).toBe(1);
        expect(render).toHaveBeenCalledTimes(12);
    });
    it('skips queued layouts and stale DOM writes after leaving the preview', async () => {
        const release = Promise.withResolvers<{ svg: string }>();
        render.mockImplementation(() => release.promise);
        const { container, diagrams, elements, renderDiagrams } = await fixture(12);
        const controller = new AbortController();
        const completed = renderDiagrams(container, diagrams, draculaTheme, controller.signal);
        await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
        controller.abort();
        release.resolve({ svg: '<svg>abandoned</svg>' });
        await completed;
        expect(render).toHaveBeenCalledTimes(1);
        expect(elements.every((element) => element.getHTML() === '')).toBe(true);
    });

    it('lets an input task run between completed layouts', async () => {
        const events: string[] = [];
        render.mockImplementation((_id, source) => {
            events.push(source);
            if (events.length === 1) setTimeout(() => events.push('input'), 0);
            return Promise.resolve({ svg: '<svg />' });
        });
        const { container, diagrams, renderDiagrams } = await fixture(3);
        await renderDiagrams(container, diagrams, draculaTheme, new AbortController().signal);
        expect(events).toEqual([
            diagrams[0].source,
            'input',
            diagrams[1].source,
            diagrams[2].source,
        ]);
    });

    it('re-seeds Mermaid and misses the cache when an edited custom theme keeps its id', async () => {
        render.mockImplementation((_id, source) =>
            Promise.resolve({ svg: `<svg>${source}</svg>` }),
        );
        const { container, diagrams, renderDiagrams } = await fixture(1);
        const signal = new AbortController().signal;
        await renderDiagrams(container, diagrams, draculaTheme, signal);
        const edited = {
            ...draculaTheme,
            colors: { ...draculaTheme.colors, elevated: '#123456' },
        };
        await renderDiagrams(container, diagrams, edited, signal);
        expect(render).toHaveBeenCalledTimes(2);
        expect(initialize).toHaveBeenCalledTimes(2);
        expect(initialize.mock.calls[1]?.[0].themeVariables?.primaryColor).toBe('#123456');
        await renderDiagrams(container, diagrams, edited, signal);
        expect(render).toHaveBeenCalledTimes(2);
        expect(initialize).toHaveBeenCalledTimes(2);
    });
});
