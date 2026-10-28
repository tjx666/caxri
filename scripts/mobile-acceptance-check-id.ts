/**
 * Whether a React Native `testID` survives as an Android semantic check id. The device helper exposes only ids of this
 * shape (lowercase, with `_.:/-` separators), so a control whose `testID` fails it is invisible to Acceptance.
 */
export const isAndroidCheckId = (value: string): boolean =>
    /^[a-z][a-z0-9_.:/-]{2,100}$/u.test(value);
