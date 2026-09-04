# Security Policy

## Supported versions

Security fixes are made on the current `main` branch and the newest tagged
release. Older snapshots may lack important capability-token, filesystem,
process-ownership, or provider-permission hardening and are not supported.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/maximyz3d/relaybridge/security/advisories/new).
Do not open a public issue for a suspected vulnerability until a maintainer has
confirmed that disclosure is safe.

Include the affected RelayBridge build ID, operating system and WSL version (if
applicable), the smallest safe reproduction, expected impact, and whether the
problem requires full-permission mode. Redact capability tokens, API keys,
provider credentials, receipt contents that may include private prompts, local
usernames, and private repository paths. A hash or synthetic fixture is usually
enough to demonstrate identity and path-handling defects.

RelayBridge controls local AI CLIs and can run with broad filesystem authority.
Do not test a report against repositories, accounts, browsers, or machines you
do not own or have explicit permission to use.
