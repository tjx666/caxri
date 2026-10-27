import { draculaTheme } from '@caxri/protocol';

/**
 * Pure HTML layout for promotional images. Nothing here touches the filesystem or a browser: the caller reads the
 * captures, passes them in as data URIs, and renders the returned document with `promo-render.ts`.
 */

/**
 * Device pixels per CSS pixel of every promo render. The PNG is the canvas size times this factor.
 */
export const PROMO_SCALE = 2;

/**
 * A PNG capture embedded in the layout.
 */
export interface PromoImage {
    /**
     * `data:image/png;base64,...` so the HTML renders offline from `about:blank` or a temp file.
     */
    dataUri: string;
    /**
     * Natural pixel width.
     */
    width: number;
    /**
     * Natural pixel height.
     */
    height: number;
}

/**
 * Everything one promo layout needs. `layout` names the arrangement; a new arrangement adds its own literal here and a
 * plan function beside `planHero`.
 */
export interface PromoLayoutInput {
    layout: 'hero-desktop-mobile';
    /**
     * Logical CSS pixels; the PNG is twice this size. readme-hero uses 1200x675.
     */
    canvas: { width: number; height: number };
    /**
     * At most two lines; longer copy fails the render instead of being clipped.
     */
    headline: string;
    /**
     * At most two lines; longer copy fails the render instead of being clipped.
     */
    subhead?: string;
    /**
     * `build/icon.png`. The layout crops its transparent-looking padding, so pass that file.
     */
    logo: PromoImage;
    /**
     * Renderer capture without native window chrome.
     */
    desktop: PromoImage;
    /**
     * Android framebuffer without a device frame.
     */
    mobile: PromoImage;
    /**
     * Desktop capture scale: physical pixels per CSS pixel of the captured window (2 on Retina). Used to place the
     * drawn traffic lights where macOS draws them for the 36px hiddenInset header.
     */
    desktopScale: number;
}

const theme = draculaTheme.colors;
const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif';

/**
 * Native macOS geometry in CSS pixels of the captured window at 100% zoom. Mirrors `window-chrome.ts` in the desktop
 * app: the Renderer's drag header is 36px tall and `trafficLightPosition` insets the buttons 15px from the left. The
 * dots are 12px with an 8px gap, so they are vertically centered in the header.
 */
const HEADER_HEIGHT = 36;
const TRAFFIC_LIGHT_LEFT = 15;
const TRAFFIC_LIGHT_SIZE = 12;
const TRAFFIC_LIGHT_GAP = 8;
const TRAFFIC_LIGHTS = ['#ff5f57', '#febc2e', '#28c840'] as const;

const WINDOW_RADIUS = 12;
const WINDOW_WIDTH_RATIO = 0.76;
const PHONE_WIDTH_RATIO = 0.22;
const PHONE_BEZEL = 9;
const PHONE_RADIUS = 40;
const LOGO_SIZE = 44;
const LOGO_RADIUS = 10;
/**
 * `build/icon.png` is a 1024px opaque tile whose squircle fills only the middle two thirds, so the logo crops to that
 * squircle: the image is drawn `LOGO_IMAGE_SIZE` px wide and offset so the visible 44px box lands on the squircle.
 */
const LOGO_IMAGE_SIZE = 70;
const LOGO_IMAGE_OFFSET = { left: -12.6, top: -12.2 };

interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface HeroPlan {
    margin: number;
    window: Rect;
    /**
     * Displayed window pixels per CSS pixel of the captured window; scales the traffic lights with the header.
     */
    windowScale: number;
    phone: Rect;
    screen: { width: number; height: number };
    headlineMaxWidth: number;
}

const DATA_URI = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * `#rrggbb` to `rgba(r, g, b, alpha)` so the Dracula tokens drive every tint.
 */
function withAlpha(hex: string, alpha: number): string {
    const value = Number.parseInt(hex.slice(1, 7), 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * Trims float noise so the CSS stays readable.
 */
function px(value: number): string {
    return `${Math.round(value * 100) / 100}px`;
}

function assertImage(name: string, image: PromoImage): void {
    if (!DATA_URI.test(image.dataUri)) {
        throw new Error(`The ${name} image must be a base64 data:image/ URI`);
    }
    if (
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        image.width <= 0 ||
        image.height <= 0
    ) {
        throw new Error(`The ${name} image needs a positive integer natural size`);
    }
}

/**
 * Refuses to draw a capture larger than it can be sharp. The PNG is rendered at `PROMO_SCALE`, so a slot of `width` x
 * `height` CSS pixels needs at least `PROMO_SCALE` times that many source pixels.
 */
function assertFitsSlot(
    name: string,
    image: PromoImage,
    slot: { width: number; height: number },
): void {
    const needWidth = Math.ceil(slot.width * PROMO_SCALE);
    const needHeight = Math.ceil(slot.height * PROMO_SCALE);
    if (image.width < needWidth || image.height < needHeight) {
        throw new Error(
            `The ${name} capture is ${image.width}x${image.height}, too small for its ` +
                `${Math.round(slot.width)}x${Math.round(slot.height)} slot at ${PROMO_SCALE}x ` +
                `(needs at least ${needWidth}x${needHeight}); recapture it larger instead of upscaling`,
        );
    }
}

function assertInput(input: PromoLayoutInput): void {
    const { width, height } = input.canvas;
    if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 400 ||
        height < 300
    ) {
        throw new Error(
            `The canvas must be at least 400x300 whole CSS pixels, received ${width}x${height}`,
        );
    }
    if (!Number.isFinite(input.desktopScale) || input.desktopScale <= 0) {
        throw new Error(`desktopScale must be a positive number, received ${input.desktopScale}`);
    }
    if (input.headline.trim() === '') throw new Error('The headline must not be empty');
    assertImage('logo', input.logo);
    assertImage('desktop', input.desktop);
    assertImage('mobile', input.mobile);
}

/**
 * Positions the hero: the window anchors the left margin and bleeds off the bottom edge, the phone sits against the
 * right margin, raised above the window's top edge so it overlaps the window's lower right.
 */
function planHero(input: PromoLayoutInput): HeroPlan {
    const { width: canvasWidth, height: canvasHeight } = input.canvas;
    const margin = Math.round(canvasWidth * 0.047);

    const windowWidth = Math.round(canvasWidth * WINDOW_WIDTH_RATIO);
    const windowHeight = Math.round((windowWidth * input.desktop.height) / input.desktop.width);
    assertFitsSlot('desktop', input.desktop, { width: windowWidth, height: windowHeight });
    const window: Rect = {
        left: margin,
        top: Math.round(canvasHeight * 0.25),
        width: windowWidth,
        height: windowHeight,
    };

    const phoneWidth = Math.round(canvasWidth * PHONE_WIDTH_RATIO);
    const screenWidth = phoneWidth - PHONE_BEZEL * 2;
    const screenHeight = Math.round((screenWidth * input.mobile.height) / input.mobile.width);
    assertFitsSlot('mobile', input.mobile, { width: screenWidth, height: screenHeight });
    const phoneHeight = screenHeight + PHONE_BEZEL * 2;
    const phoneBottomGap = Math.round(canvasHeight * 0.04);
    const phone: Rect = {
        left: canvasWidth - margin - phoneWidth,
        top: canvasHeight - phoneBottomGap - phoneHeight,
        width: phoneWidth,
        height: phoneHeight,
    };
    if (phone.top < Math.round(margin / 2)) {
        throw new Error(
            `The mobile capture is too tall: a ${phoneWidth}x${phoneHeight} phone does not fit a ` +
                `${canvasWidth}x${canvasHeight} canvas`,
        );
    }

    return {
        margin,
        window,
        windowScale: windowWidth / (input.desktop.width / input.desktopScale),
        phone,
        screen: { width: screenWidth, height: screenHeight },
        headlineMaxWidth: phone.left - margin * 2 - LOGO_SIZE - 16,
    };
}

function css(plan: HeroPlan, canvas: { width: number; height: number }): string {
    const { margin, window, phone, windowScale: s } = plan;
    const dot = TRAFFIC_LIGHT_SIZE * s;
    return `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${canvas.width}px; height: ${canvas.height}px; overflow: hidden; background: ${theme.background}; }
body { font-family: ${FONT_STACK}; color: ${theme.foreground}; -webkit-font-smoothing: antialiased; }
.canvas {
    position: relative; width: ${canvas.width}px; height: ${canvas.height}px; overflow: hidden;
    background:
        radial-gradient(ellipse 52% 78% at 92% 4%, ${withAlpha(theme.merged, 0.3)}, transparent 72%),
        radial-gradient(ellipse 58% 62% at 4% 104%, ${withAlpha(theme.accent, 0.17)}, transparent 70%),
        linear-gradient(180deg, ${theme.background} 0%, ${theme.surface} 100%);
}
.header { position: absolute; left: ${margin}px; top: ${Math.round(canvas.height * 0.07)}px; display: flex; align-items: flex-start; gap: 16px; }
.logo {
    position: relative; flex: none; width: ${LOGO_SIZE}px; height: ${LOGO_SIZE}px; margin-top: 3px; overflow: hidden;
    border-radius: ${LOGO_RADIUS}px;
    box-shadow: 0 0 0 1px ${withAlpha('#ffffff', 0.12)}, 0 8px 20px -6px ${withAlpha('#000000', 0.55)};
}
.logo img { position: absolute; width: ${LOGO_IMAGE_SIZE}px; height: ${LOGO_IMAGE_SIZE}px; left: ${LOGO_IMAGE_OFFSET.left}px; top: ${LOGO_IMAGE_OFFSET.top}px; }
.copy { max-width: ${plan.headlineMaxWidth}px; }
.headline, .subhead { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.headline { font-size: 34px; line-height: 1.14; font-weight: 650; letter-spacing: -0.022em; color: ${theme.foreground}; text-wrap: balance; }
.subhead { max-width: 640px; margin-top: 7px; font-size: 17px; line-height: 1.42; font-weight: 400; letter-spacing: -0.005em; color: ${theme.muted}; text-wrap: balance; }
.window-glow {
    position: absolute; left: ${window.left + window.width * 0.1}px; top: ${window.top + 40}px; width: ${window.width * 0.8}px; height: ${window.height * 0.7}px;
    background: radial-gradient(ellipse at 50% 40%, ${withAlpha(theme.merged, 0.34)}, ${withAlpha(theme.accent, 0.12)} 55%, transparent 75%);
    filter: blur(48px);
}
.window {
    position: absolute; left: ${window.left}px; top: ${window.top}px; width: ${window.width}px; height: ${window.height}px;
    border-radius: ${WINDOW_RADIUS}px; overflow: hidden; background: ${theme.background};
    box-shadow: 0 44px 90px -18px ${withAlpha('#000000', 0.7)}, 0 20px 40px -14px ${withAlpha('#000000', 0.55)}, 0 0 0 1px ${withAlpha('#000000', 0.5)};
}
.window > img { display: block; width: 100%; height: 100%; }
.window::after {
    content: ''; position: absolute; inset: 0; border-radius: ${WINDOW_RADIUS}px; pointer-events: none;
    box-shadow: inset 0 0 0 1px ${withAlpha('#ffffff', 0.1)}, inset 0 1px 0 0 ${withAlpha('#ffffff', 0.14)};
}
.lights { position: absolute; left: ${px(TRAFFIC_LIGHT_LEFT * s)}; top: ${px(((HEADER_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2) * s)}; display: flex; gap: ${px(TRAFFIC_LIGHT_GAP * s)}; }
.lights i { display: block; width: ${px(dot)}; height: ${px(dot)}; border-radius: 50%; box-shadow: inset 0 0 0 0.5px ${withAlpha('#000000', 0.22)}; }
.phone {
    position: absolute; left: ${phone.left}px; top: ${phone.top}px; width: ${phone.width}px; height: ${phone.height}px;
    padding: ${PHONE_BEZEL}px; border-radius: ${PHONE_RADIUS}px;
    background: linear-gradient(145deg, #1d1e26 0%, #08080b 55%, #15161c 100%);
    box-shadow:
        0 0 0 1px ${withAlpha('#000000', 0.7)},
        inset 0 0 0 1px ${withAlpha('#ffffff', 0.16)},
        inset 0 1.5px 0 0 ${withAlpha('#ffffff', 0.22)},
        0 54px 100px -20px ${withAlpha('#000000', 0.75)},
        0 24px 44px -14px ${withAlpha('#000000', 0.6)};
}
.phone .key { position: absolute; width: 3px; border-radius: 2px; background: #121319; box-shadow: inset 0 0 0 0.5px ${withAlpha('#ffffff', 0.18)}; }
.phone .key.power { right: -3px; top: ${Math.round(phone.height * 0.2)}px; height: ${Math.round(phone.height * 0.1)}px; }
.phone .key.volume { right: -3px; top: ${Math.round(phone.height * 0.34)}px; height: ${Math.round(phone.height * 0.16)}px; }
.screen { position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: ${PHONE_RADIUS - PHONE_BEZEL}px; background: #000; }
.screen img { display: block; width: 100%; height: 100%; }
.screen::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(125deg, ${withAlpha('#ffffff', 0.06)} 0%, transparent 32%);
}
.camera {
    position: absolute; left: 50%; top: 16px; width: 11px; height: 11px; margin-left: -5.5px; border-radius: 50%; z-index: 1;
    background: radial-gradient(circle at 38% 35%, #2b2d3a 0%, #07070a 62%);
    box-shadow: 0 0 0 1.5px #000, 0 0 0 2.5px ${withAlpha('#ffffff', 0.06)};
}
`;
}

/**
 * Builds the self-contained HTML for one promo image. Every asset is a data URI and every style is inline, so the
 * document renders offline from `about:blank` or a temp file. Throws a clear error when a capture is too small for its
 * slot, because the PNG is never upscaled.
 */
export function renderPromoHtml(input: PromoLayoutInput): string {
    assertInput(input);
    const plan = planHero(input);
    assertFitsSlot('logo', input.logo, { width: LOGO_IMAGE_SIZE, height: LOGO_IMAGE_SIZE });
    const subhead =
        input.subhead && input.subhead.trim() !== ''
            ? `<p class="subhead" data-promo-fit="subhead">${escapeHtml(input.subhead.trim())}</p>`
            : '';
    const lights = TRAFFIC_LIGHTS.map((color) => `<i style="background:${color}"></i>`).join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.headline.trim())}</title>
<style>${css(plan, input.canvas)}</style>
</head>
<body>
<div class="canvas">
<div class="window-glow"></div>
<header class="header" data-promo-apart="copy">
<div class="logo"><img alt="" src="${input.logo.dataUri}"></div>
<div class="copy">
<h1 class="headline" data-promo-fit="headline">${escapeHtml(input.headline.trim())}</h1>
${subhead}
</div>
</header>
<div class="window" data-promo-apart="desktop window">
<img alt="Caxri desktop app" src="${input.desktop.dataUri}">
<div class="lights">${lights}</div>
</div>
<div class="phone">
<span class="key power"></span>
<span class="key volume"></span>
<div class="screen">
<img alt="Caxri Android app" src="${input.mobile.dataUri}">
</div>
<span class="camera"></span>
</div>
</div>
</body>
</html>
`;
}
