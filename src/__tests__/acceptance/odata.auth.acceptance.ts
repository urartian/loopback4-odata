import 'reflect-metadata';

import { BindingKey, Interceptor, InvocationContext, Next, Provider, inject } from '@loopback/core';
import { HttpErrors, RestServerConfig, RequestContext } from '@loopback/rest';
import { Client, createRestAppClient, expect } from '@loopback/testlab';

import {
  Order,
  Product,
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../fixtures/odata-app.fixture';
import { odataController, odataFunction } from '../../index';

const AUTH_METADATA_KEY = 'authentication:metadata';
const AUTHZ_METADATA_KEY = 'authorization:metadata';
const TEST_USER_BINDING = BindingKey.create<{ id: string }>('test.user');

interface AuthorizationSpec {
  scopes?: string[];
  allowedRoles?: string[];
}

function authenticate(...strategies: string[]): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    const metadata = { strategy: strategies[0], strategies };
    if (propertyKey) {
      Reflect.defineMetadata(AUTH_METADATA_KEY, metadata, target, propertyKey);
    } else {
      Reflect.defineMetadata(AUTH_METADATA_KEY, metadata, target);
    }
  };
}

function authorize(spec: AuthorizationSpec): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey) {
      Reflect.defineMetadata(AUTHZ_METADATA_KEY, spec, target, propertyKey);
    } else {
      Reflect.defineMetadata(AUTHZ_METADATA_KEY, spec, target);
    }
  };
}

const splitHeaderValues = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

class TestAuthEnforcerInterceptor implements Provider<Interceptor> {
  value(): Interceptor {
    return async (invocationCtx: InvocationContext, next: Next) => {
      const methodAuth = Reflect.getMetadata(
        AUTH_METADATA_KEY,
        invocationCtx.target,
        invocationCtx.methodName,
      );
      const classAuth = Reflect.getMetadata(AUTH_METADATA_KEY, invocationCtx.targetClass);
      const authMeta = methodAuth ?? classAuth;

      const methodAuthz = Reflect.getMetadata(
        AUTHZ_METADATA_KEY,
        invocationCtx.target,
        invocationCtx.methodName,
      ) as AuthorizationSpec | undefined;
      const classAuthz = Reflect.getMetadata(AUTHZ_METADATA_KEY, invocationCtx.targetClass) as
        | AuthorizationSpec
        | undefined;
      const authzMeta = methodAuthz ?? classAuthz;

      if (!authMeta && !authzMeta) {
        return next();
      }

      const requestCtx = invocationCtx.parent as RequestContext;
      const userId = requestCtx.request.get('x-user');
      if (!userId) {
        throw new HttpErrors.Unauthorized('Missing authentication header.');
      }

      const scopeHeader = splitHeaderValues(requestCtx.request.get('x-user-scopes'));
      const roleHeader = splitHeaderValues(requestCtx.request.get('x-user-role'));

      if (authzMeta?.scopes?.length) {
        const missingScopes = authzMeta.scopes.filter((scope) => !scopeHeader.includes(scope));
        if (missingScopes.length) {
          throw new HttpErrors.Forbidden(
            `Missing required scopes: ${missingScopes.sort().join(', ')}`,
          );
        }
      }

      if (authzMeta?.allowedRoles?.length) {
        const hasRole = roleHeader.some((role) => authzMeta.allowedRoles!.includes(role));
        if (!hasRole) {
          throw new HttpErrors.Forbidden('User lacks required role.');
        }
      }

      requestCtx.bind(TEST_USER_BINDING).to({ id: userId });
      return next();
    };
  }
}

@odataController(Product)
class MethodProtectedOperationsController {
  @odataFunction({ name: 'methodProtected', binding: 'unbound' })
  @authenticate('jwt')
  @authorize({ scopes: ['incident.read'], allowedRoles: ['ADMIN'] })
  methodProtected(@inject(TEST_USER_BINDING) currentUser?: { id: string } | null) {
    return { userId: currentUser?.id ?? null };
  }
}

@authenticate('jwt')
@authorize({ scopes: ['incident.manage'], allowedRoles: ['ADMIN'] })
@odataController(Product)
class ClassProtectedOperationsController {
  @odataFunction({ name: 'classProtected', binding: 'unbound' })
  classProtected(@inject(TEST_USER_BINDING) currentUser?: { id: string } | null) {
    return { userId: currentUser?.id ?? null };
  }
}

@odataController(Order)
class OrderSecurityMetadataController {
  @authenticate('jwt')
  @authorize({ allowedRoles: ['order-manager'] })
  updateById() {}

  @authenticate('jwt')
  @authorize({ allowedRoles: ['order-manager'] })
  deleteById() {}
}

describe('OData operations authentication integration', () => {
  let app: TestApplication;
  let client: Client;

  async function givenApp(config: RestServerConfig = {}): Promise<void> {
    app = await givenODataApplication(config);
    app.interceptor(TestAuthEnforcerInterceptor, { global: true });
    app.controller(MethodProtectedOperationsController);
    app.controller(ClassProtectedOperationsController);
    app.controller(OrderSecurityMetadataController);
    await app.boot();
    await seedExampleData(app);
    await app.start();
    client = createRestAppClient(app);
  }

  beforeEach(async function () {
    try {
      await givenApp({ port: 0, host: '127.0.0.1' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = (err as Error).message ?? '';
      if (code === 'EPERM' || message.includes('not listening')) {
        this.skip();
        return;
      }
      throw err;
    }
  });

  afterEach(async () => {
    if (app?.state === 'started') {
      await app.stop();
    }
  });

  it('rejects unauthenticated access to method-level protected function', async () => {
    await client.get('/odata/methodProtected').expect(401);
  });

  it('enforces method-level scopes and roles and injects the current user', async () => {
    const res = await client
      .get('/odata/methodProtected')
      .set('x-user', 'alice')
      .set('x-user-scopes', 'incident.read,incident.write')
      .set('x-user-role', 'ADMIN')
      .expect(200);

    expect(res.body.value).to.deepEqual({ userId: 'alice' });
    expect(res.body['@odata.context']).to.equal('/odata/$metadata');
  });

  it('returns 403 when method-level scopes are missing', async () => {
    await client
      .get('/odata/methodProtected')
      .set('x-user', 'alice')
      .set('x-user-role', 'ADMIN')
      .expect(403);
  });

  it('rejects class-level protected function for users without roles', async () => {
    await client
      .get('/odata/classProtected')
      .set('x-user', 'bob')
      .set('x-user-scopes', 'incident.manage')
      .set('x-user-role', 'USER')
      .expect(403);
  });

  it('allows class-level protected function when user meets requirements', async () => {
    const res = await client
      .get('/odata/classProtected')
      .set('x-user', 'bob')
      .set('x-user-scopes', 'incident.manage')
      .set('x-user-role', 'ADMIN')
      .expect(200);

    expect(res.body.value).to.deepEqual({ userId: 'bob' });
    expect(res.body['@odata.context']).to.equal('/odata/$metadata');
  });

  describe('navigation reference endpoints', () => {
    const orderId = 1;
    const existingItemId = 1;
    const movableItemId = 5;
    const linkUrl = `/odata/Orders/${orderId}/items/$ref`;

    it('rejects unauthenticated navigation link requests', async () => {
      await client
        .post(linkUrl)
        .send({ '@odata.id': `/odata/OrderItems(${movableItemId})` })
        .expect(401);
    });

    it('rejects navigation link requests for users without the required role', async () => {
      await client
        .post(linkUrl)
        .set('x-user', 'mallory')
        .set('x-user-role', 'analyst')
        .send({ '@odata.id': `/odata/OrderItems(${movableItemId})` })
        .expect(403);
    });

    it('rejects navigation unlink requests without proper authentication or authorization', async () => {
      const unlinkUrl = `/odata/Orders/${orderId}/items/${existingItemId}/$ref`;

      await client.delete(unlinkUrl).expect(401);

      await client
        .delete(unlinkUrl)
        .set('x-user', 'mallory')
        .set('x-user-role', 'analyst')
        .expect(403);
    });

    it('allows authorized users to link and unlink navigation references', async () => {
      await client
        .post(linkUrl)
        .set('x-user', 'alice')
        .set('x-user-role', 'order-manager')
        .send({ '@odata.id': `/odata/OrderItems(${movableItemId})` })
        .expect(204);

      const linked = await client.get(`/odata/OrderItems(${movableItemId})`).expect(200);
      expect(linked.body).to.have.property('orderId', orderId);

      const unlinkUrl = `/odata/Orders/${orderId}/items/${movableItemId}/$ref`;
      await client
        .delete(unlinkUrl)
        .set('x-user', 'alice')
        .set('x-user-role', 'order-manager')
        .expect(204);

      const afterUnlink = await client.get(`/odata/OrderItems(${movableItemId})`).expect(200);
      expect(afterUnlink.body).to.have.property('orderId', null);
    });
  });
});
