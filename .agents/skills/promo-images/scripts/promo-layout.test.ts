import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pngDimensions } from './png-dimensions';
import type { PromoImage, PromoLayoutInput } from './promo-layout';
import { renderPromoHtml } from './promo-layout';

function image(marker: string, width: number, height: number): PromoImage {
    // The layout never decodes pixels, so a distinct base64 marker per image is enough to prove which slot got what.
    return {
        dataUri: `data:image/png;base64,${Buffer.from(marker).toString('base64')}`,
        width,
        height,
    };
}

function input(overrides: Partial<PromoLayoutInput> = {}): PromoLayoutInput {
    return {
        layout: 'hero-desktop-mobile',
        canvas: { width: 1200, height: 675 },
        headline: 'One workbench for every Agent',
        subhead: 'Desktop and Android, one Session list.',
        logo: image('logo', 1024, 1024),
        desktop: image('desktop', 2560, 1600),
        mobile: image('mobile', 1080, 2400),
        desktopScale: 2,
        ...overrides,
    };
}

describe('renderPromoHtml', () => {
    it('assumes the logo file its crop offsets were measured on', async () => {
        // The crop insets are fixed pixel offsets into build/icon.png; a new icon must update them, not mis-crop.
        const icon = await readFile(join(import.meta.dirname, '../../../../build/icon.png'));
        expect(pngDimensions(icon)).toEqual({ width: 1024, height: 1024 });
    });

    it('escapes the headline and subhead', () => {
        const html = renderPromoHtml(
            input({
                headline: 'Plan <b>&</b> "ship"',
                subhead: "<script>alert('x')</script>",
            }),
        );
        expect(html).toContain('Plan &lt;b&gt;&amp;&lt;/b&gt; &quot;ship&quot;');
        expect(html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>&</b>');
    });

    it('embeds the logo and both captures inline', () => {
        const value = input();
        const html = renderPromoHtml(value);
        for (const picture of [value.logo, value.desktop, value.mobile]) {
            expect(html).toContain(`src="${picture.dataUri}"`);
        }
        expect(html).not.toMatch(/(?:src|href)="(?!data:)/u);
        expect(html).not.toContain('url(http');
    });

    it('omits the subhead element when there is no subhead', () => {
        expect(renderPromoHtml(input({ subhead: undefined }))).not.toContain('class="subhead"');
    });

    it('places the traffic lights at the native hiddenInset position, scaled with the window', () => {
        // 1824px of capture at scale 2 is a 912px window, so the 912px slot shows it 1:1.
        const native = renderPromoHtml(input({ desktop: image('desktop', 1824, 1140) }));
        expect(native).toContain('.lights { position: absolute; left: 15px; top: 12px;');
        expect(native).toContain('gap: 8px;');
        expect(native).toContain('width: 12px; height: 12px; border-radius: 50%');
        for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
            expect(native).toContain(`background:${color}`);
        }
        // A 2560px capture is shown at 912 / 1280 of its CSS size, and the header scales with it.
        expect(renderPromoHtml(input())).toContain('width: 8.55px; height: 8.55px');
    });

    it('rejects a desktop capture too small for its slot instead of upscaling', () => {
        expect(() => renderPromoHtml(input({ desktop: image('desktop', 1400, 875) }))).toThrow(
            /desktop capture is 1400x875, too small for its 912x570 slot at 2x/u,
        );
    });

    it('rejects a mobile capture too small for its slot instead of upscaling', () => {
        expect(() => renderPromoHtml(input({ mobile: image('mobile', 400, 900) }))).toThrow(
            /mobile capture is 400x900, too small for its 246x554 slot at 2x/u,
        );
    });

    it('rejects an input that could break out of the markup or has no usable size', () => {
        const hostile = { ...image('x', 1080, 2400), dataUri: 'https://example.com/a.png' };
        expect(() => renderPromoHtml(input({ mobile: hostile }))).toThrow(/data:image/u);
        expect(() =>
            renderPromoHtml(
                input({
                    logo: {
                        ...image('x', 1024, 1024),
                        dataUri: 'data:image/png;base64,AA"onerror="x',
                    },
                }),
            ),
        ).toThrow(/logo image must be a base64 data:image/u);
        expect(() => renderPromoHtml(input({ canvas: { width: 100, height: 50 } }))).toThrow(
            /canvas must be at least/u,
        );
        expect(() => renderPromoHtml(input({ desktopScale: 0 }))).toThrow(/desktopScale/u);
        expect(() => renderPromoHtml(input({ headline: ' '.repeat(3) }))).toThrow(/headline/u);
    });

    it('rejects a mobile capture so tall that the phone cannot fit the canvas', () => {
        expect(() =>
            renderPromoHtml(
                input({
                    canvas: { width: 1280, height: 640 },
                    mobile: image('mobile', 1080, 2400),
                }),
            ),
        ).toThrow(/mobile capture is too tall/u);
    });
});
