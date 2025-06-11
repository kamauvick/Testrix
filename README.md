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

To install Testrix CLI, run the following command:

```bash
npm install -g testrix-cli
```

## 🛠️ Usage

1.  **Create a configuration file**: Create a `config.json` file in your project root, or a specified path. You can use the `config.json.template` as a starting point.

    ```json
    {
      "userId": "YOUR_USER_ID",
      "projectName": "Your Project Name",
      "reportsDir": "./test-reports",
      "name": "Optional: Test Run Name",
      "environment": "Optional: Environment (e.g., development, staging, production)",
      "branch": "Optional: Git Branch Name",
      "commit": "Optional: Git Commit Hash"
    }
    ```

2.  **Run Testrix CLI**: Execute the `testrix` command, optionally providing the path to your config file.

    ```bash
    testrix [path/to/your/config.json]
    ```

    If no path is provided, `testrix` will look for `config.json` in the current working directory.

    **Note on `reportsDir`**: The `reportsDir` in your `config.json` should be an absolute path or a path relative to where you execute the `testrix` command. Ensure the CLI has read access to this directory.

---

## Project Structure

```
.github/
config.json
database.sqlite
cli.js
src/
  ├── config.json.template
  ├── parsers.js
  ├── publisher.js
  └── models/
      ├── ApiKey.js
      ├── index.js
      ├── Project.js
      ├── TestCase.js
      ├── TestRun.js
      └── User.js
package.json
package-lock.json
README.md
```
