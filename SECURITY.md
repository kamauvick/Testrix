# Security Policy

## Supported versions

The latest published `1.x` release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via GitHub's ["Report a vulnerability"](https://github.com/kamauvick/Testrix/security/advisories/new)
form, or email the maintainers. Include:

- the version (`testrix --version`) and how it was invoked,
- what an attacker can do, and
- a minimal reproduction if you have one.

You'll get an acknowledgement within a few working days. We aim to ship a fix or
mitigation within 30 days and will credit you in the advisory unless you prefer
otherwise.

## Handling secrets

Testrix reads an API key (`TESTRIX_API_KEY` / `apiKey`). It is sent only as the
`x-api-key` header to the configured `serverApiUrl` and is redacted from all log
output and error messages. If you find a path where the key, or any
`Authorization`/credential value, reaches stdout, stderr, a log file, or a
thrown error, treat it as a vulnerability and report it as above.
