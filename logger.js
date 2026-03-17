/**
 * Simple logger that detects if it's running in a deployed environment (Cloud Run/Functions)
 * or locally, and formats logs accordingly for the best experience in both.
 */
export class Logger {
  constructor() {
    // K_SERVICE is set by Cloud Run and Cloud Functions (2nd gen)
    // FUNCTION_TARGET or FUNCTION_NAME are often set in Cloud Functions
    this.isDeployed = !!(
      process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET ||
      process.env.FUNCTION_NAME
    );
  }

  /**
   * Core logging method.
   *
   * @param {string} message The message to log.
   * @param {string} severity GCP severity level (DEBUG, INFO, WARNING, ERROR, etc.)
   */
  #log(message, severity = 'DEFAULT') {
    if (this.isDeployed) {
      // Structured logging for GCP: handles multi-line strings perfectly.
      // Cloud Logging will show this as a single entry, but you can expand it
      // in the console to see the full multi-line text.
      console.log(
        JSON.stringify({
          severity,
          message:
            typeof message === 'string' ? message : JSON.stringify(message),
        })
      );
    } else {
      // Simple local logging: just use the standard console.
      const consoleMethod = this.#getConsoleMethod(severity);
      console[consoleMethod](message);
    }
  }

  log(msg) {
    this.#log(msg, 'DEFAULT');
  }

  info(msg) {
    this.#log(msg, 'INFO');
  }

  warn(msg) {
    this.#log(msg, 'WARNING');
  }

  error(msg) {
    this.#log(msg, 'ERROR');
  }

  debug(msg) {
    this.#log(msg, 'DEBUG');
  }

  #getConsoleMethod(severity) {
    switch (severity) {
      case 'WARNING':
        return 'warn';
      case 'ERROR':
        return 'error';
      default:
        return 'log';
    }
  }
}

export const logger = new Logger();
