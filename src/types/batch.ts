import { Transaction } from '@loopback/repository';

export interface AtomicityRequestState {
  groupId: string;
  getTransaction(entitySetName: string): Transaction | undefined;
}
