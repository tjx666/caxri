import type { IntegerSettingSpec } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { settingUnitLabel } from './setting-spec-text';

/**
 * `incomplete` is deliberately not `invalid`. `<input type="number">` reports an empty string for text it cannot parse
 * yet, so `2.` (the keystroke in the middle of typing `2.5` into a setting that expects decimals) arrives here looking
 * exactly like a cleared field. Treating that as an error made a red border and an out-of-range sentence flash for one
 * keystroke of an entry that was never out of range. Nothing is written for either outcome; only `invalid` says the
 * user got something wrong.
 */
export type IntegerSettingInputResult =
    | { status: 'incomplete' }
    | { status: 'invalid'; error: string }
    | { status: 'valid'; value: number };

/**
 * Decimal places kept when a bound is named in error copy. `files.maxFileBytes` stores bytes and is edited in MB, so
 * its raw lower bound reads `0.0009765625`; three places keep the sentence readable.
 */
const BOUND_DECIMALS = 3;

function displayScale(spec: IntegerSettingSpec): number {
    return spec.display?.scale ?? 1;
}

/**
 * Rounds a bound away from the rejected side, so the copy never names a value the field would then refuse: the lower
 * bound rounds up and the upper bound rounds down.
 */
function formatBound(value: number, side: 'lower' | 'upper'): string {
    const factor = 10 ** BOUND_DECIMALS;
    const scaled = value * factor;
    return String((side === 'lower' ? Math.ceil(scaled) : Math.floor(scaled)) / factor);
}

function rangeMessage(t: Translate, spec: IntegerSettingSpec): string {
    const scale = displayScale(spec);
    const lower = formatBound(spec.min / scale, 'lower');
    const upper = formatBound(spec.max / scale, 'upper');
    const unit = spec.display?.unit;
    return unit
        ? t('settings.integerControl.rangeWithUnit', {
              lower,
              unit: settingUnitLabel(t, unit),
              upper,
          })
        : t('settings.integerControl.range', { lower, upper });
}

function wholeNumberMessage(t: Translate, spec: IntegerSettingSpec): string {
    const lower = formatBound(spec.min, 'lower');
    const upper = formatBound(spec.max, 'upper');
    const unit = spec.display?.unit;
    return unit
        ? t('settings.integerControl.wholeNumberWithUnit', {
              lower,
              unit: settingUnitLabel(t, unit),
              upper,
          })
        : t('settings.integerControl.wholeNumber', { lower, upper });
}

/**
 * Text the field shows for a stored value, converted into the edited unit (bytes stored, megabytes edited).
 */
export function formatIntegerSettingValue(value: number, spec: IntegerSettingSpec): string {
    const scale = displayScale(spec);
    return String(scale === 1 ? value : value / scale);
}

/**
 * Validates typed text against the setting's own range before anything is written.
 *
 * `Number('')` is `0`, and a number input happily accepts a value past its `min`/`max` attributes because those only
 * bind at form submission, which Settings never performs. Both used to reach the write channel, get refused by the
 * settings schema, and leave the field claiming a value the file never received.
 *
 * A fractional entry is refused rather than rounded when the setting is edited in its stored unit: rounding it would
 * recreate the same divergence between the visible text and the stored value.
 */
export function parseIntegerSettingInput(
    t: Translate,
    source: string,
    spec: IntegerSettingSpec,
): IntegerSettingInputResult {
    const text = source.trim();
    if (text === '') return { status: 'incomplete' };
    const shown = Number(text);
    if (!Number.isFinite(shown)) return { status: 'incomplete' };
    const scale = displayScale(spec);
    if (scale === 1 && Math.trunc(shown) !== shown)
        return { error: wholeNumberMessage(t, spec), status: 'invalid' };
    const value = scale === 1 ? shown : Math.round(shown * scale);
    return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max
        ? { status: 'valid', value }
        : { error: rangeMessage(t, spec), status: 'invalid' };
}
