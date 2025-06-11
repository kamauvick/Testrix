# Testrix CLI

**Testrix CLI** is a test results publisher for CI/CD pipelines and local environments. It parses test reports in JUnit, XML, HTML, or Excel format and uploads the results to a database for tracking, analytics, or dashboards.

---

## 📦 Features

- ✅ Supports `JUnit`, `.xml`, `.html`, and `.xls/.xlsx` test reports
- 📁 Parses test case results including status, duration, errors
- 📊 Aggregates summary statistics (total, passed, failed, skipped)
- 🛠️ Stores data in a relational database (using Sequelize ORM)
- 🧪 Designed for integration with CI tools like GitLab CI, GitHub Actions, Jenkins, etc.

---

## 🚀 Installation

```bash
npm install -g testrix-cli
