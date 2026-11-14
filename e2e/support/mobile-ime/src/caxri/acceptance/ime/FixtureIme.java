package caxri.acceptance.ime;

import android.inputmethodservice.InputMethodService;
import android.util.Base64;
import android.view.inputmethod.InputConnection;
import java.nio.charset.StandardCharsets;

/**
 * Sends synthetic acceptance text through the focused editor's input connection, without an input view.
 * @see https://developer.android.com/reference/android/view/inputmethod/InputConnection#commitText(java.lang.CharSequence,%20int)
 */
public final class FixtureIme extends InputMethodService {
    static volatile FixtureIme active;

    @Override
    public void onCreate() {
        super.onCreate();
        active = this;
    }

    @Override
    public void onDestroy() {
        if (active == this) active = null;
        super.onDestroy();
    }

    @Override
    public boolean onEvaluateInputViewShown() {
        return false;
    }

    /**
     * Writes the fixture text in one of three ways: `commit` commits it, `compose` composes and then finishes it, and
     * `hold` leaves it as the open composition, as a Chinese IME holds a typed key while its candidates show. A later
     * `hold` replaces that composition and a `commit` settles it.
     */
    boolean commitFixture(String base64, String mode) {
        InputConnection connection = getCurrentInputConnection();
        if (connection == null) return false;
        String text = new String(Base64.decode(base64, Base64.NO_WRAP), StandardCharsets.UTF_8);
        if ("hold".equals(mode)) return connection.setComposingText(text, 1);
        if ("compose".equals(mode))
            return connection.setComposingText(text, 1) && connection.finishComposingText();
        return connection.commitText(text, 1);
    }
}
