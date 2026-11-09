Follow [AGENTS.md](../AGENTS.md) for this repository. Start with its "Start here" section: ask the user which parts they
want (the dashboard, Microsoft Fabric, and Ask your data, the GitHub Copilot chat) and explain what each involves before
running anything. AGENTS.md then explains how to build the data from public sources, run the dashboard and the chat
locally, check them, and optionally publish to Microsoft Fabric with the chat relay in Azure.

Key rules: the repository ships code only, so never commit generated data (everything listed in `.gitignore`) or any
tenant, subscription, workspace, model or item IDs, hosting URLs, tokens, `.env` files or
`fabric-app/rayfin/functions/src/config.generated.ts`. Never ask for or handle the GitHub OAuth App's client secret; the
user stores it themselves. Keep the README's demo disclaimer.
