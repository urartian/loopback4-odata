import {OperationObject} from '@loopback/openapi-v3';

export type ODataVisibility = 'documented' | 'undocumented';

export function markUndocumentedOperation<T extends OperationObject>(spec: T): T {
  return {
    ...spec,
    'x-odata-generated': true,
    'x-odata-visibility': 'undocumented',
  };
}
