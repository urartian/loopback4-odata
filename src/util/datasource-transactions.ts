import { AnyObject, IsolationLevel, Transaction, juggler } from '@loopback/repository';

export type TransactionCapability = 'supported' | 'unsupported' | 'unknown';

export interface TransactionCapabilityProbe {
  capability: TransactionCapability;
  error?: unknown;
}

export function dataSourceSupportsTransactions(dataSource: juggler.DataSource): boolean {
  const connector = dataSource.connector as AnyObject | undefined;
  const connectorSupports = typeof connector?.beginTransaction === 'function';
  const defaultBeginTransaction = juggler.DataSource.prototype.beginTransaction;
  const hasCustomMethod =
    typeof dataSource.beginTransaction === 'function' &&
    dataSource.beginTransaction !== defaultBeginTransaction;
  return connectorSupports || hasCustomMethod;
}

export async function probeDataSourceTransactionalCapability(
  dataSource: juggler.DataSource,
): Promise<TransactionCapabilityProbe> {
  if (!dataSourceSupportsTransactions(dataSource)) return { capability: 'unsupported' };
  let tx: Transaction | undefined;
  try {
    tx = (await dataSource.beginTransaction(IsolationLevel.READ_COMMITTED)) as Transaction;
  } catch (error) {
    const capability = classifyTransactionalError(error);
    if (capability === 'unknown') return { capability, error };
    return { capability };
  }
  try {
    await tx.rollback?.();
  } catch {
    /* ignore cleanup errors */
  }
  return { capability: 'supported' };
}

function classifyTransactionalError(error: unknown): TransactionCapability {
  if (!error) return 'unknown';
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (statusCode === 501) return 'unsupported';
  const message = (error as Error)?.message?.toLowerCase() ?? '';
  if (message.includes('not implemented') || message.includes('not support')) {
    return 'unsupported';
  }
  return 'unknown';
}
