# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting on the [Security advisories](https://github.com/xxcupid/cc-bridge/security/advisories) page and select **Report a vulnerability**. Do not publish sensitive reproduction details.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Remove app secrets, access tokens, prompts, workspace contents, and personal identifiers from reports.

## Security model

- Feishu credentials are read from environment variables or a private `0600` service environment file.
- Claude Code is executed locally with the selected workspace and the user's own authentication.
- `default` mode requires user approval for sensitive Agent actions. `yolo` remains bounded by `maxAccess` but carries greater risk.
- Workspace path validation is not an operating-system sandbox. Use a dedicated account or container for stronger isolation.

Only supported releases receive security fixes. This `0.x` project should be treated as pre-stable software.
