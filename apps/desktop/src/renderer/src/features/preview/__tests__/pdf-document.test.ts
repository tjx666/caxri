import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadPdfDocument } from '../pdf-document';

const workerPorts: MessagePort[] = [];

/**
 * A valid one-page PDF showing `text` in the non-embedded Helvetica font. The E2E fixture builder in
 * `e2e/support/synthetic-pdf.ts` is outside the Renderer's TypeScript project, so this is its minimal Renderer twin.
 */
function onePagePdf(text: string): Uint8Array {
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let body = '%PDF-1.7\n';
    const offsets = objects.map((object, index) => {
        const offset = body.length;
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
        return offset;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(body);
}

/**
 * The modern build relies on Uint8Array and Map methods Node 24 does not ship yet. The legacy build is the same source
 * transpiled for older runtimes, so the loading lifecycle under test is unchanged.
 */
vi.mock('pdfjs-dist', () => import('pdfjs-dist/legacy/build/pdf.mjs'));

/**
 * Stands in for the bundled module worker with pdf.js's real worker code on the far end of an in-process channel, so
 * the main-thread loading lifecycle (shared port, `destroy()` round trip) runs exactly as it does in the Renderer.
 */
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker', async () => {
    const { WorkerMessageHandler } = (await import(
        // @ts-expect-error -- pdf.js publishes no declarations for its worker entry
        'pdfjs-dist/legacy/build/pdf.worker.mjs'
    )) as {
        WorkerMessageHandler: { initializeFromPort: (port: MessagePort) => void };
    };
    return {
        default: class {
            constructor() {
                const { port1, port2 } = new MessageChannel();
                port1.start();
                port2.start();
                workerPorts.push(port1, port2);
                WorkerMessageHandler.initializeFromPort(port2);
                return port1;
            }
        },
    };
});
/**
 * Keeps this suite able to fail with the original bug: the old implementation published the channel end as
 * `GlobalWorkerOptions.workerPort`, which pdf.js accepts only when it is a `Worker`, and Node has none.
 */
vi.stubGlobal('Worker', MessagePort);
vi.mock('../../../lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../stores/toasts', () => ({ pushToast: vi.fn() }));

afterAll(() => {
    for (const port of workerPorts) port.close();
});

describe('loadPdfDocument', () => {
    it('reports a damaged file even while the previous document is still being destroyed', async () => {
        const previous = loadPdfDocument(onePagePdf('Page one'));
        await previous.promise;

        // Switching tabs tears the previous document down without waiting for the worker to acknowledge it.
        const destroyed = previous.destroy();
        const next = loadPdfDocument(new TextEncoder().encode('not a PDF\n'));

        await expect(next.promise).rejects.toMatchObject({ name: 'InvalidPDFException' });
        await destroyed;
    });

    it('keeps an open document usable after another document is destroyed', async () => {
        const keptTask = loadPdfDocument(onePagePdf('Kept page'));
        const kept = await keptTask.promise;
        const other = loadPdfDocument(onePagePdf('Other page'));
        await other.promise;
        await other.destroy();

        const page = await kept.getPage(1);
        const text = await page.getTextContent();
        expect(text.items.map((item) => ('str' in item ? item.str : ''))).toContain('Kept page');
        await keptTask.destroy();
    });
});
