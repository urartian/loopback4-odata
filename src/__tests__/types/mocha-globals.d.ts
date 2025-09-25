interface MochaContext {
  skip(): void;
}

declare function describe(title: string, fn: () => void | Promise<void>): void;
declare function it(title: string, fn?: () => void | Promise<void>): void;
declare function beforeEach(fn: (this: MochaContext) => void | Promise<void>): void;
declare function afterEach(fn: (this: MochaContext) => void | Promise<void>): void;
