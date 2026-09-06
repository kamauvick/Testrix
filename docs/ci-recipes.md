# CI recipes

Copy-paste starting points. In every case, set `TESTRIX_PROJECT_ID` and
`TESTRIX_API_KEY` as secrets in your provider - everything else (branch,
commit, environment, user, report location) is auto-detected. `testrix init`
prints the snippet for whichever of these it detects you're running in.

## GitHub Actions

```yaml
# .github/workflows/test.yml
- run: npm test # however your suite writes test-results/*.xml
- run: npx testrix-cli
  if: always() # publish results even when tests failed
  env:
    TESTRIX_PROJECT_ID: ${{ secrets.TESTRIX_PROJECT_ID }}
    TESTRIX_API_KEY: ${{ secrets.TESTRIX_API_KEY }}
```

## GitLab CI

```yaml
# .gitlab-ci.yml
test:
  script:
    - npm test
    - npx testrix-cli
  variables:
    TESTRIX_PROJECT_ID: $TESTRIX_PROJECT_ID
    TESTRIX_API_KEY: $TESTRIX_API_KEY
  when: always
```

## CircleCI

```yaml
# .circleci/config.yml
- run:
    name: Run tests
    command: npm test
- run:
    name: Publish test results
    command: npx testrix-cli
    when: always
    environment:
      TESTRIX_PROJECT_ID: $TESTRIX_PROJECT_ID
```

(Set `TESTRIX_API_KEY` as a CircleCI project/context environment variable
rather than inlining it.)

## Jenkins (declarative pipeline)

```groovy
// Jenkinsfile
post {
  always {
    withCredentials([string(credentialsId: 'testrix-api-key', variable: 'TESTRIX_API_KEY')]) {
      sh 'npx testrix-cli'
    }
  }
}
```

## Bitbucket Pipelines

```yaml
# bitbucket-pipelines.yml
- step:
    script:
      - npm test
      - npx testrix-cli
    after-script:
      - npx testrix-cli # if you only want to publish on failure, put it here instead
```

## Any other CI

```bash
npm test
TESTRIX_PROJECT_ID=... TESTRIX_API_KEY=... npx testrix-cli
```

`branch`/`commit`/`name` will fall back to `git` if the CI provider isn't one
Testrix recognises yet (`src/ci.js` - GitHub Actions, GitLab CI, CircleCI,
Jenkins, Bitbucket Pipelines today); `userId` falls back further to the OS
user.

## Publishing on failure too

A test failure should still produce a published run - that's the point of
tracking flakiness and failure trends. Put the `testrix-cli` step where your
CI's "always run" mechanism is (`if: always()` on GitHub Actions, `when:
always` on GitLab/CircleCI, an Bitbucket `after-script`, `post { always {} }`
on Jenkins) rather than only after a successful test step.

## Gating the build on results

By default a successful publish exits `0` even if tests failed - Testrix's
job is to record results, not to be the test runner. If you want the
`testrix-cli` step itself to fail the build:

```bash
npx testrix-cli --fail-on-failed   # non-zero exit if any test failed
npx testrix-cli --fail-on-empty    # non-zero exit if zero tests were found (silent-failure guard)
```
