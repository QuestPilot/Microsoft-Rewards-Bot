# Contributing to Microsoft Rewards Bot

Thank you for your interest in contributing to Microsoft Rewards Bot. This document provides guidelines for contributing to the **source-available public edition** of this project.

By contributing, you agree to the contribution license in [LICENSE](../LICENSE). Contributions may be used by the official project in the public edition, Core, documentation, dashboards, installers, update systems, and related products.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Plugin Development](#plugin-development)

---

## Code of Conduct

By participating in this project, you agree to:

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what's best for the community
- Accept criticism gracefully

**Unacceptable behavior includes:**

- Harassment, trolling, or personal attacks
- Publishing others' private information
- Spam or off-topic discussions

Violations may result in a ban from the project.

---

## How Can I Contribute?

### 🐛 Reporting Bugs

Before submitting a bug report:

1. Check the [existing issues](https://github.com/QuestPilot/Microsoft-Rewards-Bot/issues)
2. Ensure you're using the latest version
3. Verify you're using Node.js v24.15.0

**Good bug reports include:**

- Clear title (e.g., "Search fails on mobile when...")
- Steps to reproduce
- Expected vs. actual behavior
- Logs (remove sensitive info!)
- Environment details:
    ```
    - Bot version: 4.0.1
    - Node.js version: v24.15.0
    - OS: Windows 11 / Ubuntu 22.04 / macOS 14
    - Docker: Yes/No
    ```

### 💡 Suggesting Features

Feature requests are welcome for the **core** (free tier). For premium features, please discuss in our [Discord server](https://discord.gg/k5uHkx9mne) first.

**Good feature requests include:**

- Clear use case
- Why it benefits the community
- Whether it should be core or a plugin

### 🔧 Contributing Code

We accept pull requests for:

- **Bug fixes** (core or helpers)
- **New core features** (free tier functionality)
- **Documentation improvements**
- **Performance optimizations**
- **Test coverage improvements**
- **Plugin examples** (see [Plugin Development](#plugin-development))

**We do NOT accept:**

- Premium features without proper license checks
- Breaking changes to the plugin API without discussion
- Code that violates Microsoft's Terms of Service
- Code that bypasses license validation
- Code that reproduces, unlocks, bypasses, or replaces official Core functionality
- Public competing forks or renamed copies of the project

---

## Development Setup

### Prerequisites

- Node.js v24.15.0
- Git
- A Microsoft account (for testing)

### Setup Steps

1. **Fork and clone**

    ```bash
    git clone https://github.com/QuestPilot/Microsoft-Rewards-Bot.git
    cd Microsoft-Rewards-Bot
    ```

2. **Install dependencies**

    ```bash
    npm install
    npx patchright install chromium
    ```

3. **Configure for development**

    ```bash
    cp src/accounts.example.json src/accounts.json
    cp src/config.example.json src/config.json
    ```

    Edit `dist/accounts.json` with a test account (not your main account!).

4. **Build and run**
    ```bash
    npm run build
    npm start
    ```

### Project Structure

```
src/
├── automation/          # Browser automation (Patchright, selectors, auth)
├── context/             # Shared context for plugins
├── core/                # Core business logic
│   ├── ActivityRunner.ts    # Main orchestrator
│   ├── PluginAPI.ts         # Plugin interface definitions
│   ├── PluginManager.ts     # Plugin loader
│   ├── TaskBase.ts          # Base task class (free tier logic)
│   └── tasks/               # Core tasks (searches, quizzes, etc.)
├── helpers/             # Utilities (logger, HTTP client, etc.)
├── notifications/       # Discord/Ntfy webhooks
├── types/               # TypeScript type definitions
└── index.ts             # Entry point

plugins/
└── core/                # Pre-installed official Core plugin (compiled)

dist/                    # Compiled JavaScript output
```

---

## Coding Standards

### TypeScript

- Use **TypeScript** (no plain JavaScript)
- Enable strict mode (`tsconfig.json` already configured)
- Type all function parameters and return types
- Avoid `any` unless absolutely necessary

### Style

- **Indentation:** 4 spaces (no tabs)
- **Line length:** Max 120 characters
- **Semicolons:** Required
- **Quotes:** Single quotes for strings (unless escaping required)
- **Naming:**
    - `PascalCase` for classes and types
    - `camelCase` for variables and functions
    - `SCREAMING_SNAKE_CASE` for constants

### Example

```typescript
export class SearchOrchestrator {
    private bot: MicrosoftRewardsBot
    private readonly MAX_RETRIES = 3

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async executeSearch(query: string): Promise<boolean> {
        // Implementation
    }
}
```

### Comments

- Use comments for **why**, not **what**
- Document complex logic
- Keep comments up-to-date with code changes
- Use JSDoc for public APIs:

```typescript
/**
 * Executes a Bing search with the given query
 * @param query - The search term
 * @returns True if search succeeded, false otherwise
 */
public async executeSearch(query: string): Promise<boolean> {
    // ...
}
```

---

## Commit Guidelines

### Commit Message Format

```
<type>(<scope>): <subject>

<optional body>

<optional footer>
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring (no functional change)
- `perf`: Performance improvements
- `test`: Adding or fixing tests
- `chore`: Build process, dependencies, or tooling

**Scopes:**

- `core`: Core business logic
- `automation`: Browser automation
- `auth`: Authentication
- `search`: Search tasks
- `daily-set`: Daily Set tasks
- `plugin-api`: Plugin system
- `docker`: Docker configuration
- `docs`: Documentation

**Examples:**

```
feat(search): add random scroll behavior to searches

Adds random scrolling and clicking on search results to mimic
human behavior and reduce detection risk.

Closes #123
```

```
fix(auth): handle TOTP code timeout gracefully

Previously, the bot would crash if TOTP code expired during login.
Now retries with a fresh code.

Fixes #456
```

### Commit Best Practices

- **One logical change per commit**
- **Write clear commit messages** (future you will thank you)
- **Reference issues** (`Closes #123`, `Fixes #456`)
- **Keep commits atomic** (can be reverted independently)

---

## Pull Request Process

### Before Submitting

1. **Ensure your code builds**

    ```bash
    npm run build
    ```

2. **Test your changes**
    - Run the bot with your changes
    - Verify no regressions
    - Test edge cases

3. **Update documentation**
    - Update README.md if you added features
    - Update plugin-api.md if you changed the plugin API
    - Add comments to complex code

4. **Check for secrets**
    - No hardcoded credentials
    - No API keys or tokens
    - No personal account information

### Submitting

1. **Create a feature branch**

    ```bash
    git checkout -b feat/your-feature-name
    ```

2. **Push your branch**

    ```bash
    git push origin feat/your-feature-name
    ```

3. **Open a Pull Request**
    - Use a clear title (same format as commits)
    - Describe what changed and why
    - Reference related issues
    - Add screenshots/logs if applicable

**PR Template:**

```markdown
## Description

Brief description of the changes.

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing

- [ ] Tested on Windows / Linux / macOS
- [ ] Tested with free tier
- [ ] Tested with official Core plugin when relevant
- [ ] No regressions detected

## Related Issues

Closes #123
```

### Review Process

- Maintainers will review your PR within **1-2 weeks**
- Address requested changes promptly
- Be open to feedback
- Once approved, a maintainer will merge your PR

---

## Plugin Development

### Creating a Plugin

Plugins extend the bot's functionality. See the [Plugin Development Guide](../docs/plugin-api.md) for a complete reference.

**Quick example:**

```typescript
import type { IPlugin, PublicPluginContext } from 'microsoft-rewards-bot/plugin-api'

export default class MyPlugin implements IPlugin {
    name = 'my-plugin'
    version = '1.0.0'

    async register(context: PublicPluginContext): Promise<void> {
        context.registerSelectors({
            MY_SELECTOR: { button: '#my-button' }
        })

        context.registerDiagnostics(() => [
            { level: 'info', message: 'my-plugin is active' }
        ])
    }

    async destroy(): Promise<void> {
        // Cleanup
    }
}
```

### Plugin Guidelines

- **Open-source plugins:** Share in the community Discord or submit as an example
- **Proprietary plugins:** You can create private plugins (we won't review them)
- **License compliance:** Ensure your plugin respects the project license, the Core boundary, and any third-party licenses
- **Security:** Never share credentials or API keys in plugin code
- **Premium boundary:** Third-party plugins cannot register official Core premium tasks

---

## Questions?

- **Discord:** [Join our server](https://discord.gg/k5uHkx9mne)
- **Issues:** [GitHub Issues](https://github.com/QuestPilot/Microsoft-Rewards-Bot/issues)
- **Plugin API:** [Read the docs](../docs/plugin-api.md)

---

Thank you for contributing! 🎉
