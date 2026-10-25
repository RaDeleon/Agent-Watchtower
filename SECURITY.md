# Security policy

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](https://github.com/RaDeleon/Agent-Watchtower/security/advisories/new) (the **Security** tab, then **Report a vulnerability**). Do not open a public issue or pull request for it.

Include what is affected, how to reproduce it, and what an attacker could do. Leave real credentials, databases and transcripts out of the report.

## Scope

Watchtower runs locally. Reports are most useful about:

- a capture script or hook that could break, slow or leak data from Claude Code;
- the dashboard (`watchtower serve`), which should bind only to loopback;
- an adapter that writes to a source it should only read, or that copies conversation content;
- the release archive, the release script or the secret and privacy checks.

## Supported versions

Only the latest release is supported. Fixes land on `main` and ship in the next release; older releases are not patched.
