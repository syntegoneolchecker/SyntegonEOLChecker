# Code Quality Tools Setup

This repository is configured with three free code quality tools that work automatically on every push.

---

## 1. CodeQL (GitHub Security Scanning)

CodeQL is GitHub's built-in security scanner. It detects:

- Security vulnerabilities (SQL injection, XSS, etc.)
- CWE patterns
- Common coding mistakes

### CodeQL Settings:

1. Go to your GitHub repository
2. Click **Settings** → **Advanced Security**
3. Scroll down to **Code scanning** -> find **CodeQL analysis**

### Configuration and Execution
CodeQL is executed on every push to the repository through GitHub Actions. 
- The workflow can be found under **.github/workflows/codeql.yml**
- Configuration to filter out certain warnings is present in **.github/codeql/codeql-config.yml**

The filtered warnings are coming from issues that are inherent to the applications functionality (like using user controlled input during EOL checking). These issues have been handled through different security implementations but CodeQL still marks them. The filters remove these false positives.

To view CodeQLs findings, open the **Security** tab in the repository and select **Code scanning**. Each issue is presented in a ticket-system-like format.

---

## 2. SonarCloud (Code Quality Analysis)

SonarCloud provides comprehensive code quality metrics:

- Bugs, vulnerabilities, code smells
- Technical debt tracking
- Test coverage
- Duplication detection

### Usage

SonarCloud can be used with its free tier on public repositories. The free tier has the following limitations:
- Only one branch is getting analyzed on pushes (the develop branch in this case)
- The default Quality Gate cannot be changed

Once the analysis is completed after a push to the develop branch, check the results here: https://sonarcloud.io/project/overview?id=syntegoneolchecker_SyntegonEOLChecker

---

## 3. ESLint (JavaScript Linting)

ESLint catches JavaScript-specific issues:

- Syntax errors
- Unused variables
- Inconsistent code style
- Best practice violations

### Local Development:

Run ESLint locally to catch issues before pushing:

```bash
# Check all files
npm run lint

# Auto-fix issues
npm run lint:fix

```

### Configuration:

Rules are defined in `eslint.config.js` (ESLint v9+ flat config format). Current settings:

- No unused variables (warning, ignores `_` prefixed)
- No undefined variables (error)
- Strict equality required (error)
- Prefer const over let (warning)
- No var allowed (error)
- No trailing spaces (warning)

---

## Code Quality Process

The general process of using these tools could look like this:
1. Pull the branch and develop locally
2. Use ESLint in the command line during development to find and fix issues
3. Use the SonarQube extension locally to find issues
4. Before pushing, run tests locally
5. After pushing, wait for GitHub Actions to complete
6. Check CodeQL findings in the GitHub web UI and look at the SonarCloud analysis results
7. Fix issues that were missed earlier until none remain
