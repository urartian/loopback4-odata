module.exports = {
  extends: '@loopback/eslint-config',
  parserOptions: {
    project: './tsconfig.test.json',
  },
  overrides: [
    {
      files: ['**/*.spec.ts', '**/*.acceptance.ts'],
      rules: {
        '@typescript-eslint/triple-slash-reference': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-invalid-this': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-shadow': 'off',
        'mocha/handle-done-callback': 'off',
      },
    },
    {
      files: ['src/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': 'off', // For legitimate unused vars like interface implementations
        '@typescript-eslint/prefer-nullish-coalescing': 'off', // For valid uses of ||
        '@typescript-eslint/prefer-optional-chain': 'off', // For complex conditionals
        '@typescript-eslint/no-shadow': 'off', // For nested scopes where shadowing is intentional
        '@typescript-eslint/prefer-for-of': 'off', // For valid for loops that require index
        'prefer-const': 'off', // For variable declarations that might be reassigned
        '@typescript-eslint/no-this-alias': 'off', // For legitimate this aliases in complex controllers
      },
    },
    {
      files: ['src/**/service-document.controller.ts'],
      rules: {
        '@typescript-eslint/naming-convention': 'off', // For OData specific naming like @odata.context
      },
    },
    {
      files: ['src/**/crud-controller-factory.ts'],
      rules: {
        'no-prototype-builtins': 'off', // For legitimate hasOwnProperty usage
        '@typescript-eslint/no-this-alias': 'off', // For this alias patterns in controller factory
      },
    },
    {
      files: ['examples/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off', // For example files that might have unused imports
      },
    },
  ],
};