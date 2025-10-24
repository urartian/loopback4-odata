import {belongsTo, Entity, model, property} from '@loopback/repository';

@model()
export class SapSalesOrder extends Entity {
  @property({type: 'string', id: true})
  ID!: string;

  @property({type: 'number'})
  netAmount!: number;
}

@model()
export class SapSalesOrderItem extends Entity {
  @property({type: 'string', id: true})
  itemId!: string;

  @belongsTo(() => SapSalesOrder, {name: 'salesOrder', keyFrom: 'salesOrderId', keyTo: 'ID'})
  salesOrderId!: string;

  @property({type: 'number'})
  quantity!: number;

  @property({type: 'number'})
  unitPrice!: number;
}
