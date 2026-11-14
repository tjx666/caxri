package expo.modules.caxricomposerspans

import android.graphics.Typeface
import android.text.Spannable
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.util.TypedValue
import android.widget.EditText
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.WeakHashMap

/** One styled run of the composer draft, in the field's own text offsets. Colors are Android ARGB values. */
class ComposerRun : Record {
  @Field val from: Int = 0
  @Field val to: Int = 0
  @Field val color: Double? = null
  @Field val backgroundColor: Double? = null
  /** Font size in sp, scaled like the field's own text. */
  @Field val fontSize: Double? = null
  @Field val bold: Boolean = false
  @Field val italic: Boolean = false
  @Field val strike: Boolean = false
  @Field val monospace: Boolean = false
}

/**
 * Styles the Chat composer's draft in place. React Native's Android text field rewrites its whole text whenever its
 * `<Text>` children change (`ReactEditText.maybeSetText`), which drops and re-creates a Chinese IME's open composition
 * on every key and makes the lines jump. The composer keeps a plain `value` instead, which React Native never writes
 * back while the reader types, and this module only adds or removes spans on the text the field already holds, the
 * way Expensify's react-native-live-markdown styles its field.
 *
 * @see https://github.com/Expensify/react-native-live-markdown
 */
class CaxriComposerSpansModule : Module() {
  /** The spans this module added to each field, so the next call removes exactly those. */
  private val applied = WeakHashMap<EditText, List<Any>>()

  override fun definition() = ModuleDefinition {
    Name("CaxriComposerSpans")

    AsyncFunction("apply") { viewTag: Int, text: String, runs: List<ComposerRun> ->
      apply(viewTag, text, runs)
    }.runOnQueue(Queues.MAIN)
  }

  /**
   * Whether the runs were applied. A draft that no longer matches the field (the reader typed again before this call
   * arrived) is skipped: the render that follows that keystroke sends runs for the new text.
   */
  private fun apply(viewTag: Int, text: String, runs: List<ComposerRun>): Boolean {
    val context = appContext.reactContext as? ReactContext ?: return false
    val field = UIManagerHelper.getUIManagerForReactTag(context, viewTag)?.resolveView(viewTag) as? EditText
      ?: return false
    val editable = field.text ?: return false
    applied.remove(field)?.forEach(editable::removeSpan)
    if (editable.toString() != text) return false
    val metrics = field.resources.displayMetrics
    val added = mutableListOf<Any>()
    for (run in runs) {
      if (run.from < 0 || run.to > editable.length || run.from >= run.to) continue
      val spans = buildList {
        run.color?.let { add(ForegroundColorSpan(it.toLong().toInt())) }
        run.backgroundColor?.let { add(BackgroundColorSpan(it.toLong().toInt())) }
        run.fontSize?.let {
          add(AbsoluteSizeSpan(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, it.toFloat(), metrics).toInt()))
        }
        if (run.bold) add(StyleSpan(Typeface.BOLD))
        if (run.italic) add(StyleSpan(Typeface.ITALIC))
        if (run.strike) add(StrikethroughSpan())
        if (run.monospace) add(TypefaceSpan("monospace"))
      }
      for (span in spans) {
        // Exclusive at both ends, so a key typed at a run's edge takes the field's plain look until the next render.
        editable.setSpan(span, run.from, run.to, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        added.add(span)
      }
    }
    applied[field] = added
    return true
  }
}
