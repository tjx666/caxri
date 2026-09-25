package caxri.acceptance;

import android.util.Base64;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;
import java.nio.charset.StandardCharsets;

/** Asserts fixture-owned composer state without exposing the text in diagnostics. */
public final class MobileUnicodeInput extends UiAutomatorTestCase {
    private UiObject composerInput() {
        return new UiObject(new UiSelector().description("session-composer-input"));
    }

    private String fixtureText() {
        String encoded = getParams().getString("textBase64");
        if (encoded == null) throw new IllegalArgumentException("Missing fixture text");
        return new String(Base64.decode(encoded, Base64.NO_WRAP), StandardCharsets.UTF_8);
    }

    public void testFocusComposer() throws Exception {
        UiObject input = composerInput();
        if (!input.exists()) throw new IllegalStateException("Composer input is unavailable");
        input.click();
        if (!input.isFocused()) throw new IllegalStateException("Composer is not focused");
    }

    public void testAssertDraft() throws Exception {
        if (!fixtureText().equals(composerInput().getText()))
            throw new IllegalStateException("Composer draft differs from fixture");
    }

    public void testAssertComposerFocused() throws Exception {
        if (!composerInput().isFocused()) throw new IllegalStateException("Composer is not focused");
    }

    public void testAssertUnknownFeedback() throws Exception {
        UiObject feedback = new UiObject(new UiSelector().description("session-composer-feedback"));
        if (!feedback.exists() || !feedback.getText().contains("Couldn't confirm delivery"))
            throw new IllegalStateException("Unknown delivery feedback is unavailable");
    }
}
