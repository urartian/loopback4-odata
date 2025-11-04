/// <reference path="../../types/testing.globals.d.ts" />

import { ODataLoggerProvider } from '../../providers/odata-logger.provider';
import { ODataConfig, ODataLogEntry } from '../../types';
import { expect, sinon } from '@loopback/testlab';

describe('ODataLoggerProvider', () => {
  const baseLogger = () => ({
    trace: sinon.stub(),
    debug: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
  });

  it('delegates to application logger when available', () => {
    const logger = baseLogger();
    const app = {
      logger,
      getSync: () => ({}) as ODataConfig,
    } as any;

    const provider = new ODataLoggerProvider(app);
    const resolved = provider.value();

    resolved.warn('delegated');
    expect(logger.warn.calledWith('delegated')).to.be.true();
  });

  it('wraps logger to emit onLog events', () => {
    const logger = baseLogger();
    const cfg: ODataConfig = {
      onLog: (entry) => events.push(entry),
    };
    const app = {
      logger,
      getSync: () => cfg,
    } as any;
    const events: ODataLogEntry[] = [];

    const provider = new ODataLoggerProvider(app);
    const resolved = provider.value();

    resolved.warn('test warning', { foo: 'bar' });
    expect(logger.warn.calledWith('test warning', { foo: 'bar' })).to.be.true();
    expect(events).to.have.length(1);
    expect(events[0]).to.containDeep({
      level: 'warn',
      message: 'test warning',
      context: { foo: 'bar' },
    });
  });

  it('falls back to console logger when application logger is absent', () => {
    const app = {
      getSync: () => ({}) as ODataConfig,
    } as any;
    const provider = new ODataLoggerProvider(app);
    const resolved = provider.value();

    expect(resolved).to.be.Object();
    expect(typeof resolved.warn).to.equal('function');
  });
});
