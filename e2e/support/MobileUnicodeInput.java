package caxri.acceptance;

import android.os.Bundle;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;
import java.nio.charset.StandardCharsets;

/** Sends fixture-owned Unicode text through the Android accessibility input action. */
public final class MobileUnicodeInput extends UiAutomatorTestCase {
    private static final String INPUT_SENTINEL = "x";

    private static final class EditableObject extends UiObject {
        EditableObject(UiSelector selector) {
            super(selector);
        }

        void setUnicodeText(String text) {
            AccessibilityNodeInfo node = findAccessibilityNodeInfo(1000);
            if (node == null) throw new IllegalStateException("Composer input is unavailable");
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments))
                throw new IllegalStateException("Composer text action failed");
        }

        void selectEnd(int textLength) {
            AccessibilityNodeInfo node = findAccessibilityNodeInfo(1000);
            if (node == null) throw new IllegalStateException("Composer input is unavailable");
            Bundle arguments = new Bundle();
            arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, textLength);
            arguments.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, textLength);
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, arguments))
                throw new IllegalStateException("Composer selection action failed");
        }
    }

    private EditableObject composerInput() {
        return new EditableObject(new UiSelector().description("session-composer-input"));
    }

    private String fixtureText() {
        String encoded = getParams().getString("textBase64");
        if (encoded == null) throw new IllegalArgumentException("Missing fixture text");
        return new String(Base64.decode(encoded, Base64.NO_WRAP), StandardCharsets.UTF_8);
    }

    public void testSetUnicodeText() throws Exception {
        String text = fixtureText();
        EditableObject input = composerInput();
        if (!input.exists()) throw new IllegalStateException("Composer input is unavailable");
        // Match the user's input order before changing a controlled React Native TextInput.
        input.click();
        if (!input.isFocused()) throw new IllegalStateException("Composer is not focused");
        // Accessibility SET_TEXT can retain native text without updating React's controlled draft.
        // Delete the trailing sentinel through a real key event to publish the exact final Unicode text.
        String staged = text + INPUT_SENTINEL;
        input.setUnicodeText(staged);
        input.selectEnd(staged.length());
        if (!getUiDevice().pressDelete()) throw new IllegalStateException("Composer delete action failed");
        if (!text.equals(input.getText())) throw new IllegalStateException("Composer text differs from fixture");
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
