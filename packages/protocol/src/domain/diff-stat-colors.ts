/**
 * The chroma ceiling for a diff-stat color. Theme `success` / `danger` roles are often tuned as loud status colors
 * (Dracula's are near the sRGB gamut edge); capping both at one chroma keeps the two counts equally saturated, so
 * neither reads as the heavier figure.
 */
const MAX_CHROMA = 0.15;

interface Oklch {
    lightness: number;
    chroma: number;
    hue: number;
}

function srgbToLinear(value: number): number {
    return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
    return value <= 0.003_130_8 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/**
 * Converts an sRGB `#rrggbb` (an alpha suffix is ignored) to OKLCH, per https://bottosson.github.io/posts/oklab/.
 */
function hexToOklch(hexColor: string): Oklch {
    const hex = hexColor.replace('#', '');
    const [red, green, blue] = [0, 2, 4].map((start) =>
        srgbToLinear(Number.parseInt(hex.slice(start, start + 2), 16) / 255),
    );
    const l = Math.cbrt(0.412_221_470_8 * red + 0.536_332_536_3 * green + 0.051_445_992_9 * blue);
    const m = Math.cbrt(0.211_903_498_2 * red + 0.680_699_545_1 * green + 0.107_396_956_6 * blue);
    const s = Math.cbrt(0.088_302_461_9 * red + 0.281_718_837_6 * green + 0.629_978_700_5 * blue);
    const a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
    const b = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
    return {
        lightness: 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        chroma: Math.hypot(a, b),
        hue: Math.atan2(b, a),
    };
}

/**
 * Returns linear sRGB channels, which fall outside [0, 1] when the color is out of gamut.
 */
function oklchToLinearSrgb({ lightness, chroma, hue }: Oklch): [number, number, number] {
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);
    const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
    const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
    const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
    return [
        4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
        -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
        -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
    ];
}

function isInGamut(color: Oklch): boolean {
    return oklchToLinearSrgb(color).every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

function linearChannelToHex(channel: number): string {
    const clamped = Math.min(1, Math.max(0, linearToSrgb(channel)));
    return Math.round(clamped * 255)
        .toString(16)
        .padStart(2, '0');
}

/**
 * Maps into sRGB by lowering chroma at a fixed lightness and hue, so the equalized lightness survives.
 */
function oklchToHex(color: Oklch): string {
    let mapped = color;
    if (!isInGamut(color)) {
        let low = 0;
        let high = color.chroma;
        for (let step = 0; step < 24; step++) {
            const chroma = (low + high) / 2;
            if (isInGamut({ ...color, chroma })) low = chroma;
            else high = chroma;
        }
        mapped = { ...color, chroma: low };
    }
    return `#${oklchToLinearSrgb(mapped).map(linearChannelToHex).join('')}`;
}

/**
 * Derives the `+N -M` changed-line count colors from a theme's `success` and `danger` roles.
 *
 * Each keeps its own hue, but both move to the pair's mean OKLCH lightness with a shared chroma ceiling. Status colors
 * are rarely balanced — Dracula's green sits at L 0.87 and its red at L 0.68 — and in a sidebar read from peripheral
 * vision, where shape is judged mostly by lightness, that gap made the red count look taller than the green one even
 * though both render at identical pixel heights. Paseo balances its diff colors the same way (equal lightness, only the
 * hue changes).
 */
export function diffStatColors(
    success: string,
    danger: string,
): { added: string; removed: string } {
    const added = hexToOklch(success);
    const removed = hexToOklch(danger);
    const lightness = (added.lightness + removed.lightness) / 2;
    return {
        added: oklchToHex({
            lightness,
            chroma: Math.min(added.chroma, MAX_CHROMA),
            hue: added.hue,
        }),
        removed: oklchToHex({
            lightness,
            chroma: Math.min(removed.chroma, MAX_CHROMA),
            hue: removed.hue,
        }),
    };
}

/**
 * Exposed for tests: the OKLCH lightness of an sRGB `#rrggbb` color.
 */
export function oklchLightness(hexColor: string): number {
    return hexToOklch(hexColor).lightness;
}
