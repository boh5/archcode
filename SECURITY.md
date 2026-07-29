# Security policy

## Supported versions

Security reports are accepted for the latest ArchCode release and the current
`main` branch. Older releases may no longer receive a patch; maintainers will
identify the affected and fixed versions when coordinating a report.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities, credentials, authentication
bypasses, or private-workspace exposure in a public issue or pull request.

Use GitHub's private vulnerability reporting flow:

1. Open the repository's **Security and quality** tab.
2. Open **Advisories**.
3. Select **Report a vulnerability**.

Include enough information for maintainers to reproduce and assess the issue:

- affected version, commit, or component;
- security impact and realistic attack conditions;
- reproduction steps or a minimal proof of concept;
- relevant logs with secrets and personal data removed;
- any known workaround or suggested fix;
- whether and where the issue has already been disclosed.

If the private reporting button is unavailable, open a public issue containing
no vulnerability details and ask the maintainer for a private contact channel.

If a real credential has been exposed, revoke or rotate it immediately before
submitting the report.

## Coordinated disclosure

Maintainers will acknowledge the report as soon as practical, investigate its
impact, and coordinate a fix and disclosure with the reporter. Do not publish
technical details before a fix or advisory is available unless the maintainers
and reporter agree on a disclosure timeline.
