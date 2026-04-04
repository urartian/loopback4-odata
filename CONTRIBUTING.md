# Contributing to @urartian/loopback4-odata

Thank you for your interest in contributing to @urartian/loopback4-odata! This document provides guidelines and information for contributors.

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- Node.js 22.x
- npm 8+
- Git

### Development Setup

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/loopback4-odata.git
   cd loopback4-odata
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run the tests to verify everything works:
   ```bash
   npm test
   ```

5. Start the example application:
   ```bash
   npm run dev
   ```

## Development Workflow

### Branch Naming

Use descriptive branch names that indicate the type of change:
- `feature/add-new-query-option`
- `fix/batch-timeout-handling`
- `docs/api-reference-update`
- `refactor/simplify-error-handling`

### Code Style

This project uses ESLint and Prettier for code formatting:

```bash
# Check linting
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code
npm run format
```

**Important**: All code must pass linting checks before being merged.

### Testing

We maintain high test coverage and expect all contributions to include tests:

```bash
# Run all tests
npm test

# Run tests with coverage (if available)
npm run test:coverage

# Run only unit tests
npm run test:unit

# Run only acceptance tests
npm run test:acceptance
```

#### Test Categories

- **Unit Tests**: Located in `src/__tests__/unit/` - test individual functions and classes
- **Acceptance Tests**: Located in `src/__tests__/acceptance/` - test complete scenarios with real HTTP requests

#### Writing Tests

- All new features must include comprehensive tests
- Bug fixes should include regression tests
- Use descriptive test names that explain the scenario
- Follow the existing test patterns and structure

### Commit Messages

Use clear, descriptive commit messages following conventional commits:

```
feat: add $search support for complex properties
fix: resolve batch timeout handling in nested changesets
docs: update API reference for ODataConfig interface
test: add coverage for lambda pushdown edge cases
refactor: simplify error code standardization
```

Types:
- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation changes
- `test`: Test additions or modifications
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `chore`: Build process or auxiliary tool changes

## What to Contribute

### Priority Areas

We welcome contributions in these high-priority areas:

1. **Bug Fixes**: Address issues in the GitHub issue tracker
2. **Performance Improvements**: Query optimization, memory usage reduction
3. **Documentation**: API docs, examples, tutorials
4. **Database Connectors**: Support for additional databases
5. **OData Features**: Missing query options, functions, or protocol features

### Areas We Need Help With

- **Testing**: Improve test coverage, add edge case tests
- **Documentation**: User guides, API reference improvements
- **Examples**: Real-world usage examples and tutorials
- **Performance**: Benchmarking and optimization
- **Accessibility**: Making the library easier to use

## Submitting Changes

### Pull Request Process

1. **Create an Issue First**: For significant changes, create an issue to discuss the approach
2. **Keep PRs Focused**: One feature or fix per pull request
3. **Update Documentation**: Include relevant documentation updates
4. **Add Tests**: Ensure new code is well-tested
5. **Update Changelog**: Add an entry to `CHANGELOG.md` if applicable

### Pull Request Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix/feature causing existing functionality to not work as expected)
- [ ] Documentation update

## Testing
- [ ] Tests pass locally with `npm test`
- [ ] New tests added for new functionality
- [ ] Existing tests updated if needed

## Checklist
- [ ] Code follows style guidelines (`npm run lint` passes)
- [ ] Self-review of code completed
- [ ] Documentation updated
- [ ] Changes work with example application
```

### Review Process

1. **Automated Checks**: All PRs must pass CI checks (tests, linting, build)
2. **Code Review**: Maintainers will review for code quality, design, and functionality
3. **Testing**: Reviewers may test changes manually
4. **Feedback**: Address review comments promptly
5. **Approval**: At least one maintainer approval required

### Release Contract Review

Before cutting a release candidate, review the public contract explicitly:

1. **Public API Surface**: Recheck exported symbols in `src/index.ts` and confirm any additions or removals are intentional.
2. **API Reference**: Run `npm run docs:api` and review the generated TypeDoc output for unexpected surface changes.
3. **Contract Notes**: Update `docs/pre-v1-notes.md` or the release notes when the supported contract changes.

## Issue Reporting

### Bug Reports

Use the GitHub issue template and include:

- **Environment**: Node.js version, OS, database connector
- **Steps to Reproduce**: Clear, minimal reproduction steps  
- **Expected Behavior**: What you expected to happen
- **Actual Behavior**: What actually happened
- **Code Samples**: Minimal code example demonstrating the issue
- **Error Messages**: Full stack traces or error messages

### Feature Requests

When requesting new features:

- **Use Case**: Explain why this feature would be valuable
- **Proposal**: Describe the proposed solution or API
- **Alternatives**: Mention alternative approaches considered
- **OData Compliance**: Reference relevant OData specification sections

## Development Environment

### Recommended Tools

- **IDE**: Visual Studio Code with TypeScript extension
- **Database**: PostgreSQL for testing database-specific features
- **HTTP Client**: REST client for testing OData endpoints
- **Git Client**: Command line or GUI client

### Environment Variables

Set these for full local development:

```bash
# For signed token testing
export ODATA_TOKEN_SECRET=$(openssl rand -hex 32)

# For database testing (optional)
export PG_HOST=localhost
export PG_USER=postgres
export PG_PASSWORD=password
export PG_DATABASE=odata_test
```

### Debugging

To debug the example application:

1. Start in debug mode: `npm run dev`
2. Use VS Code debugger or Node.js inspector
3. Set breakpoints in TypeScript source files
4. Test with HTTP client against `http://localhost:3001/odata`

## Architecture Overview

### Key Components

- **Component** (`src/component.ts`): Main LoopBack 4 component
- **Decorators** (`src/decorators/`): Model and controller decorators
- **Controllers** (`src/controllers/`): Generated CRUD and metadata controllers
- **Services** (`src/services/`): Query parsing, execution, media handling
- **Middleware** (`src/middleware/`): Request processing pipeline
- **Utilities** (`src/util/`): Helper functions and utilities

### Extension Points

The library provides several extension points:

- **Media Handlers**: Custom binary data handling
- **Apply Executors**: Database-specific query optimization
- **Throttle Stores**: Custom rate limiting backends
- **Error Providers**: Custom error handling

## Release Process

### Semantic Versioning

We follow [Semantic Versioning](https://semver.org/):

- **PATCH** (1.0.1): Bug fixes, no breaking changes
- **MINOR** (1.1.0): New features, backward compatible
- **MAJOR** (2.0.0): Breaking changes

### Version 1.0 Stability Promise

Starting with v1.0.0, we commit to:
- **API Stability**: No breaking changes in minor releases
- **Documentation**: Complete API documentation
- **LTS Support**: Long-term support for major versions
- **Migration Guides**: Clear upgrade paths for breaking changes

## Questions and Support

### Getting Help

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: Questions and community discussions
- **Documentation**: Check README and API documentation first
- **Examples**: Review the `examples/` directory

### Community

- **Be Respectful**: Follow our code of conduct
- **Be Patient**: Maintainers are volunteers
- **Be Helpful**: Help other community members
- **Be Constructive**: Provide actionable feedback

## Recognition

Contributors are recognized in:
- **GitHub Contributors**: Automatic recognition in the repository
- **Release Notes**: Significant contributions mentioned in releases
- **Documentation**: Contributors credited in relevant sections

Thank you for contributing to @urartian/loopback4-odata! 🎉

---

For questions about contributing, please open a GitHub Discussion or issue.
