# Code Quality Tools Setup Guide

This repository is configured with three free code quality tools that work automatically on every push. Here's how to enable them:

---

## 🔒 1. CodeQL (GitHub Security Scanning)

**Status**: ✅ Ready to use (no configuration needed)

CodeQL is GitHub's built-in security scanner. It detects:
- Security vulnerabilities (SQL injection, XSS, etc.)
- CWE patterns
- Common coding mistakes

### Activation Steps:
1. Go to your GitHub repository
2. Click **Settings** → **Code security and analysis**
3. Enable **Code scanning** → **Set up** → **Default**
4. CodeQL will run automatically on every push

**First run**: Happens automatically on next push to `main` or any `claude/**` branch.

---

## 📊 2. SonarCloud (Code Quality Analysis)

**Status**: ⚙️ Requires one-time setup

SonarCloud provides comprehensive code quality metrics:
- Bugs, vulnerabilities, code smells
- Technical debt tracking
- Test coverage
- Duplication detection

### Activation Steps:

#### Step 1: Create SonarCloud Account
1. Go to https://sonarcloud.io
2. Click **Log in** → **With GitHub**
3. Authorize SonarCloud to access your repositories

#### Step 2: Import Repository
1. Click **+** (top right) → **Analyze new project**
2. Select your organization: `syntegoneolchecker`
3. Choose repository: `SyntegonEOLChecker`
4. Click **Set Up**

#### Step 3: Add GitHub Secret
1. Go to your GitHub repository
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `SONAR_TOKEN`
5. Value: Copy from SonarCloud dashboard (**My Account** → **Security** → **Generate Token**)
6. Click **Add secret**

**First run**: Happens automatically on next push after token is added.

### What You'll See:
- **Quality Gate**: Pass/Fail status
- **Bugs**: Potential runtime errors
- **Vulnerabilities**: Security issues
- **Code Smells**: Maintainability issues
- **Duplications**: Repeated code blocks
- **Coverage**: Test coverage percentage

---

## 🔍 3. ESLint (JavaScript Linting)

**Status**: ✅ Ready to use (runs in test workflow)

ESLint catches JavaScript-specific issues:
- Syntax errors
- Unused variables
- Inconsistent code style
- Best practice violations

### Activation:
Already integrated into the test workflow! Runs automatically on every push.

### Local Development:
Run ESLint locally to catch issues before pushing:

```bash
# Check all files
npx eslint netlify/functions/**/*.js scraping-service/**/*.js script.js test.js

# Auto-fix issues
npx eslint --fix netlify/functions/**/*.js scraping-service/**/*.js script.js test.js

# Check specific file
npx eslint netlify/functions/fetch-url.js
```

### Configuration:
Rules are defined in `.eslintrc.json`. Current settings:
- No unused variables (warning)
- Semicolons required (error)
- Prefer const over let (warning)
- No var allowed (error)
- Consistent indentation (4 spaces)

---

## 📈 Expected Results

After setup, you'll see:

### On Every Push:
1. ✅ **Tests** run (existing)
2. 🔍 **ESLint** runs (warns about code style)
3. 🔒 **CodeQL** scans for security issues
4. 📊 **SonarCloud** analyzes code quality

### GitHub Checks:
All workflows appear as checks on pull requests and commits:
- ✅ Run Tests (ESLint + unit tests)
- ✅ CodeQL Analysis
- ✅ SonarCloud Analysis

### Dashboards:
- **CodeQL**: GitHub → Security → Code scanning alerts
- **SonarCloud**: https://sonarcloud.io/dashboard?id=syntegoneolchecker_SyntegonEOLChecker
- **ESLint**: Check GitHub Actions logs

---

## 🎯 Quality Metrics to Track

### CodeQL Targets:
- 🎯 **0 critical vulnerabilities**
- 🎯 **0 high-severity issues**

### SonarCloud Targets:
- 🎯 **A rating** on Reliability
- 🎯 **A rating** on Security
- 🎯 **A rating** on Maintainability
- 🎯 **<3% duplicated code**
- 🎯 **>80% test coverage** (future)

### ESLint Targets:
- 🎯 **<50 warnings** (currently configured)
- 🎯 **0 errors**

---

## 🔧 Troubleshooting

### SonarCloud Not Running?
- ✅ Check that `SONAR_TOKEN` secret is added
- ✅ Verify organization name matches: `syntegoneolchecker`
- ✅ Check workflow logs in Actions tab

### CodeQL Failing?
- ✅ CodeQL auto-builds the project - ensure `npm install` works
- ✅ Check if any dependencies are missing

### ESLint Too Strict?
Edit `.eslintrc.json` to adjust rules:
- Change `"error"` to `"warn"` for softer enforcement
- Change `"warn"` to `"off"` to disable a rule
- Adjust `--max-warnings` in `.github/workflows/test.yml`

---

## 📚 Additional Resources

- **CodeQL Docs**: https://codeql.github.com/docs/
- **SonarCloud Docs**: https://docs.sonarcloud.io/
- **ESLint Rules**: https://eslint.org/docs/rules/

---

## ✅ Next Steps

1. **Enable CodeQL** in repository settings (1 minute)
2. **Set up SonarCloud** account and token (5 minutes)
3. **Push to trigger workflows** - see results in ~2-3 minutes
4. **Review findings** and create issues for high-priority items
5. **Iterate** - fix issues, push, repeat

**Total Setup Time**: ~10 minutes
**Ongoing Maintenance**: Automatic - just review alerts as they appear
