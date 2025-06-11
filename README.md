# Testrix CLI

**Testrix CLI** is a command-line tool designed to parse test reports (JUnit, XML, HTML, Excel) and publish the results to a specified server API. This allows for centralized tracking, analytics, and dashboards for your CI/CD pipelines and local environments.

---

## 📦 Features

- ✅ Parses `JUnit`, `.xml`, `.html`, and `.xls/.xlsx` test reports
- 📁 Extracts test case results including status, duration, and error details
- 📊 Aggregates summary statistics (total, passed, failed, skipped)
- 🌐 **Publishes results to a configurable server API endpoint**
- 🧪 Designed for integration with CI tools like GitLab CI, GitHub Actions, Jenkins, etc.

---

## 🚀 Installation

To install Testrix CLI, run the following command:

```bash
npm install -g testrix-cli
```

## 🛠️ Usage

1.  **Create a configuration file**: Create a `config.json` file in your project root, or a specified path. You can use the `src/config.json.template` as a starting point.

    ```json
    {
      "serverApiUrl": "http://localhost:3000/api/test-reports",
      "userId": "YOUR_USER_ID",
      "projectName": "Your Project Name",
      "projectDescription": "Optional: A description for your project.",
      "reportsDir": "./test-reports",
      "name": "Optional: Test Run Name",
      "environment": "Optional: Environment (e.g., development, staging, production)",
      "branch": "Optional: Git Branch Name",
      "commit": "Optional: Git Commit Hash"
    }
    ```

    *   `serverApiUrl`: The URL of your server's API endpoint where test reports will be sent (e.g., `http://your-server.com/api/test-reports`).
    *   `userId`: A unique identifier for the user initiating the test run. This will be sent to your server.
    *   `projectName`: The name of the project associated with the test run.
    *   `reportsDir`: The local directory where your test report files are located. This should be an absolute path or a path relative to where you execute the `testrix` command. Ensure the CLI has read access to this directory.

2.  **Run Testrix CLI**: Execute the `testrix` command, optionally providing the path to your config file.

    ```bash
    testrix [path/to/your/config.json]
    ```

    If no path is provided, `testrix` will look for `config.json` in the current working directory.

---

## Project Structure

```
.github/
cli.js
package.json
package-lock.json
README.md
src/
  ├── config.json.template
  ├── parsers.js
  └── publisher.js
```

**Note**: Testrix CLI no longer manages a local SQLite database directly. It sends data to your configured server API, which is responsible for database storage.
