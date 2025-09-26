/* Global declarations for mocha-style tests */

interface TestContext {
  skip(): void;
}

declare function describe(title: string, fn: () => void | Promise<void>): void;
declare function it(title: string, fn?: () => void | Promise<void>): void;
declare function beforeEach(fn: (this: TestContext) => void | Promise<void>): void;
declare function afterEach(fn: (this: TestContext) => void | Promise<void>): void;
