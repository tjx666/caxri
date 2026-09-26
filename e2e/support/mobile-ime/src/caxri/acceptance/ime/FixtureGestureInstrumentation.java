package caxri.acceptance.ime;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;

/**
 * Injects one two-pointer gesture into the foreground acceptance WebView.
 * UiAutomation can inject across packages; the IME's own package is the instrumentation target.
 * @see https://developer.android.com/reference/android/app/UiAutomation#injectInputEvent(android.view.InputEvent,%20boolean)
 */
public final class FixtureGestureInstrumentation extends Instrumentation {
    private static final int STEPS = 12;
    private Bundle arguments;

    @Override
    public void onCreate(Bundle input) {
        super.onCreate(input);
        arguments = input;
        start();
    }

    @Override
    public void onStart() {
        Bundle result = new Bundle();
        try {
            String gesture = arguments == null ? null : arguments.getString("gesture");
            if (!"pinch-in".equals(gesture) && !"pinch-out".equals(gesture))
                throw new GestureFailure("invalid-gesture");
            int left = coordinate("left");
            int top = coordinate("top");
            int right = coordinate("right");
            int bottom = coordinate("bottom");
            if (left < 0 || top < 0 || right - left < 120 || bottom - top < 120)
                throw new GestureFailure("invalid-bounds");
            UiAutomation automation = getUiAutomation();
            if (automation == null) throw new GestureFailure("automation-unavailable");
            perform(automation, gesture, left, top, right, bottom);
            result.putString("gesture", gesture);
            result.putString("status", "ok");
            finish(Activity.RESULT_OK, result);
        } catch (GestureFailure error) {
            result.putString("status", "failed");
            result.putString("reason", error.reason);
            finish(Activity.RESULT_CANCELED, result);
        } catch (RuntimeException error) {
            result.putString("status", "failed");
            result.putString("reason", "unexpected-error");
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private int coordinate(String key) {
        if (arguments == null || !arguments.containsKey(key))
            throw new GestureFailure("missing-bounds");
        String value = arguments.getString(key);
        if (value == null || !value.matches("[0-9]{1,5}"))
            throw new GestureFailure("invalid-bounds");
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException error) {
            throw new GestureFailure("invalid-bounds");
        }
    }

    private void perform(
        UiAutomation automation,
        String gesture,
        int left,
        int top,
        int right,
        int bottom
    ) {
        float centerX = (left + right) / 2f;
        float centerY = (top + bottom) / 2f;
        float span = Math.min(right - left, bottom - top);
        float startSeparation = span * ("pinch-in".equals(gesture) ? 0.64f : 0.18f);
        float endSeparation = span * ("pinch-in".equals(gesture) ? 0.18f : 0.64f);
        long downTime = SystemClock.uptimeMillis();
        int activePointers = 0;
        float separation = startSeparation;
        try {
            activePointers = 1;
            inject(automation, downTime, MotionEvent.ACTION_DOWN, 1,
                centerX - separation / 2f, centerY, centerX + separation / 2f, centerY);
            activePointers = 2;
            inject(automation, downTime,
                MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                2, centerX - separation / 2f, centerY, centerX + separation / 2f, centerY);
            for (int step = 1; step <= STEPS; step++) {
                SystemClock.sleep(16);
                separation = startSeparation +
                    (endSeparation - startSeparation) * step / STEPS;
                inject(automation, downTime, MotionEvent.ACTION_MOVE, 2,
                    centerX - separation / 2f, centerY, centerX + separation / 2f, centerY);
            }
            inject(automation, downTime,
                MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
                2, centerX - separation / 2f, centerY, centerX + separation / 2f, centerY);
            activePointers = 1;
            inject(automation, downTime, MotionEvent.ACTION_UP, 1,
                centerX - separation / 2f, centerY, centerX + separation / 2f, centerY);
            activePointers = 0;
        } finally {
            if (activePointers > 0) {
                inject(automation, downTime, MotionEvent.ACTION_CANCEL, activePointers,
                    centerX - separation / 2f, centerY, centerX + separation / 2f, centerY);
            }
        }
    }

    private void inject(
        UiAutomation automation,
        long downTime,
        int action,
        int pointerCount,
        float firstX,
        float firstY,
        float secondX,
        float secondY
    ) {
        MotionEvent.PointerProperties[] properties =
            new MotionEvent.PointerProperties[pointerCount];
        MotionEvent.PointerCoords[] coordinates = new MotionEvent.PointerCoords[pointerCount];
        for (int index = 0; index < pointerCount; index++) {
            MotionEvent.PointerProperties pointer = new MotionEvent.PointerProperties();
            pointer.id = index;
            pointer.toolType = MotionEvent.TOOL_TYPE_FINGER;
            properties[index] = pointer;
            MotionEvent.PointerCoords point = new MotionEvent.PointerCoords();
            point.x = index == 0 ? firstX : secondX;
            point.y = index == 0 ? firstY : secondY;
            point.pressure = 1f;
            point.size = 1f;
            coordinates[index] = point;
        }
        MotionEvent event = MotionEvent.obtain(
            downTime,
            SystemClock.uptimeMillis(),
            action,
            pointerCount,
            properties,
            coordinates,
            0,
            0,
            1f,
            1f,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0
        );
        try {
            if (!automation.injectInputEvent(event, true))
                throw new GestureFailure("injection-failed");
        } finally {
            event.recycle();
        }
    }

    private static final class GestureFailure extends RuntimeException {
        final String reason;

        GestureFailure(String reason) {
            this.reason = reason;
        }
    }
}
