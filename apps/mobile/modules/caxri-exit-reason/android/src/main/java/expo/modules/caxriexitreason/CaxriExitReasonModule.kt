package expo.modules.caxriexitreason

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val PREFERENCES = "caxri_exit_reason"
private const val UNCAUGHT_CLASS = "uncaughtClass"
private const val UNCAUGHT_AT = "uncaughtAt"

/** Caps the read; Android keeps only a short exit history per package anyway. */
private const val MAX_EXITS = 16

/**
 * Reads why this app's previous main process ended, so the next connection can report a crash Caxri would otherwise
 * never see. Android's exit record names no exception, so an uncaught-exception handler keeps the class name of the last
 * Java crash beside it; the message and stack are never stored.
 */
class CaxriExitReasonModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("CaxriExitReason")

    OnCreate {
      installUncaughtExceptionRecorder(context.applicationContext)
    }

    AsyncFunction("readPreviousExits") {
      readPreviousExits(context)
    }
  }

  /**
   * The main process's recent exits, newest first. A crash reported while offline can be followed by an ordinary exit,
   * so reading only the newest record would lose it.
   */
  private fun readPreviousExits(context: Context): List<Map<String, Any?>> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
    val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val uncaughtClass = preferences.getString(UNCAUGHT_CLASS, null)
    val uncaughtAt = preferences.getLong(UNCAUGHT_AT, 0L).takeIf { it > 0L }?.toDouble()
    return manager.getHistoricalProcessExitReasons(context.packageName, 0, MAX_EXITS)
      .filter { it.processName == context.packageName }
      .map { exit ->
        mapOf(
          "pid" to exit.pid,
          "reason" to exit.reason,
          "importance" to exit.importance,
          "timestamp" to exit.timestamp.toDouble(),
          "uncaughtClass" to uncaughtClass,
          "uncaughtAt" to uncaughtAt,
        )
      }
  }

  private companion object {
    @Volatile
    private var isRecorderInstalled = false

    /**
     * Wraps the current default handler once per process. The write is synchronous because the process dies right
     * after the handler returns; a failed write is ignored so the original handler always runs.
     */
    @Synchronized
    fun installUncaughtExceptionRecorder(context: Context) {
      if (isRecorderInstalled) return
      isRecorderInstalled = true
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        try {
          context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(UNCAUGHT_CLASS, error.javaClass.name)
            .putLong(UNCAUGHT_AT, System.currentTimeMillis())
            .commit()
        } catch (_: Throwable) {
        }
        previous?.uncaughtException(thread, error)
      }
    }
  }
}
