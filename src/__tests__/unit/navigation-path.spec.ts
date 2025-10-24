/// <reference path="../../types/testing.globals.d.ts" />

import {expect} from '@loopback/testlab';
import 'reflect-metadata';
import {NavigationPathError, resolveNavigationPath} from '../../util/navigation-path';
import {OrderItem, Order, Product} from '../../../examples/basic-app';
import {SapSalesOrder, SapSalesOrderItem} from '../fixtures/sap-app.fixture';

describe('Navigation path resolver', () => {
  it('resolves belongsTo path on OrderItem', () => {
    const result = resolveNavigationPath(OrderItem, 'order/total');

    expect(result.joins).to.have.length(1);
    expect(result.originalPath).to.equal('order/total');
    const join = result.joins[0];
    expect(join.relationName).to.equal('order');
    expect(join.relationType).to.equal('belongsTo');
    expect(join.sourceKey).to.equal('orderId');
    expect(join.targetKey).to.equal('id');
    expect(result.propertyPath).to.equal('total');
    expect(result.targetModel).to.equal(Order);
  });

  it('resolves hasMany path on Product', () => {
    const result = resolveNavigationPath(Product, 'orderItems/unitPrice');

    expect(result.joins).to.have.length(1);
    expect(result.originalPath).to.equal('orderItems/unitPrice');
    const join = result.joins[0];
    expect(join.relationType).to.equal('hasMany');
    expect(join.sourceKey).to.equal('id');
    expect(join.targetKey).to.equal('productId');
    expect(result.propertyPath).to.equal('unitPrice');
  });

  it('throws for unsupported through relations', () => {
    expect(() => resolveNavigationPath(Product, 'orders/name')).to.throw(NavigationPathError);
  });

  it('throws when path exceeds depth', () => {
    expect(() => resolveNavigationPath(Product, 'orderItems/order/product', {maxDepth: 2})).to.throw(
      NavigationPathError,
    );
  });

  it('resolves belongsTo path when target resolver returns a factory object', () => {
    const relation = SapSalesOrderItem.definition.relations.salesOrder as {target: unknown};
    const originalTarget = relation.target;
    relation.target = () => ({entity: SapSalesOrder});

    try {
      const result = resolveNavigationPath(SapSalesOrderItem, 'salesOrder/ID');

      expect(result.joins).to.have.length(1);
      const [join] = result.joins;
      expect(join.relationType).to.equal('belongsTo');
      expect(join.targetKey).to.equal('ID');
      expect(result.targetModel).to.equal(SapSalesOrder);
      expect(result.propertyPath).to.equal('ID');
    } finally {
      relation.target = originalTarget;
    }
  });
});
