import { Transaction, juggler } from '@loopback/repository';

export interface AtomicityRequestState {
  groupId: string;
  dataSource?: juggler.DataSource;
  dataSourceKey?: string;
  getTransaction(entitySetName: string): Transaction | undefined;
}
