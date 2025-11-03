import { Application, CoreBindings, inject, Provider } from '@loopback/core';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import { ODataConfig, ODataLogEntry } from '../types';

export class ODataLoggerProvider implements Provider<ODataLogger> {
  constructor(@inject(CoreBindings.APPLICATION_INSTANCE) private readonly app: Application) {}

  value(): ODataLogger {
    const base = this.resolveApplicationLogger() ?? createConsoleLogger();
    return wrapLogger(base, () => this.resolveConfig()?.onLog);
  }

  private resolveApplicationLogger(): ODataLogger | undefined {
    return (this.app as unknown as { logger?: ODataLogger })?.logger;
  }

  private resolveConfig(): ODataConfig | undefined {
    try {
      return this.app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    } catch {
      return undefined;
    }
  }
}

function createConsoleLogger(): ODataLogger {
  return {
    trace(message, context) {
      console.debug(prefixMessage('trace', message), context ?? {});
    },
    debug(message, context) {
      console.debug(prefixMessage('debug', message), context ?? {});
    },
    info(message, context) {
      console.info(prefixMessage('info', message), context ?? {});
    },
    warn(message, context) {
      console.warn(prefixMessage('warn', message), context ?? {});
    },
    error(message, context, error) {
      if (error) {
        console.error(prefixMessage('error', message), { ...(context ?? {}), error });
      } else {
        console.error(prefixMessage('error', message), context ?? {});
      }
    },
  };
}

function prefixMessage(level: string, message: string): string {
  return `[OData][${level}] ${message}`;
}

function wrapLogger(
  base: ODataLogger,
  hookResolver: () => ((entry: ODataLogEntry) => void) | undefined,
): ODataLogger {
  const emit = (entry: ODataLogEntry) => {
    const hook = hookResolver();
    if (!hook) return;
    try {
      hook(entry);
    } catch (error) {
      base.warn('Failed to execute onLog handler.', { error });
    }
  };
  return {
    trace(message, context) {
      const entry: ODataLogEntry = { level: 'trace', message, context };
      emit(entry);
      base.trace(message, context);
    },
    debug(message, context) {
      const entry: ODataLogEntry = { level: 'debug', message, context };
      emit(entry);
      base.debug(message, context);
    },
    info(message, context) {
      const entry: ODataLogEntry = { level: 'info', message, context };
      emit(entry);
      base.info(message, context);
    },
    warn(message, context) {
      const entry: ODataLogEntry = { level: 'warn', message, context };
      emit(entry);
      base.warn(message, context);
    },
    error(message, context, error) {
      const entry: ODataLogEntry = { level: 'error', message, context, error };
      emit(entry);
      base.error(message, context, error);
    },
  };
}
