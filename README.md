# garmin-mcp

Personlig MCP-connector, der giver Claude læseadgang til mine egne Garmin Connect-data via Garmins Personal API. Den kører som en Cloudflare Worker, og kun GitHub-brugeren `bhojland-dev` kan logge ind.

## Værktøjer

| Værktøj | Hvad det gør |
| --- | --- |
| `list_activities` | Seneste træninger, filtreret på dato og type (fx `swimming`) |
| `get_activity` | Opsummering af én træning inkl. Garmins split-opsummeringer |
| `get_activity_laps` | Alle omgange/intervaller fra den originale FIT-fil: distance, tid, tempo pr. 100 m, tag, SWOLF, puls. Kan også give hver bane |
| `get_activity_workout` | Den planlagte træning, hvis træningen blev svømmet som struktureret workout |
| `check_garmin_connection` | Tjekker, at nøglen virker, og at Garmin kan nås |

## Hemmeligheder

Sættes i Cloudflare under Worker → Settings → Variables and Secrets (aldrig i koden):

- `GITHUB_CLIENT_ID` og `GITHUB_CLIENT_SECRET` fra GitHub OAuth-appen
- `COOKIE_ENCRYPTION_KEY`: en tilfældig streng, fx fra `openssl rand -hex 32`
- `GARMIN_API_KEY`: den personlige API-nøgle fra Garmin Connect

## Opsætning

1. Forbind repositoriet i Cloudflare (Workers & Pages → Create → Import a repository). Worker-navnet skal være `garmin-mcp`.
2. Opret en GitHub OAuth-app med callback-URL `https://garmin-mcp.<subdomæne>.workers.dev/callback`.
3. Sæt hemmelighederne ovenfor, og ret `MCP_RESOURCE` i `wrangler.jsonc` til `https://garmin-mcp.<subdomæne>.workers.dev/mcp`.
4. Tilføj `https://garmin-mcp.<subdomæne>.workers.dev/mcp` som custom connector i Claude.

Garmin-nøglen udløber efter den periode, der blev valgt ved oprettelsen. Lav en ny nøgle og opdater `GARMIN_API_KEY`, før den udløber.

Bygget på Cloudflares skabelon `remote-mcp-github-oauth` fra [cloudflare/ai](https://github.com/cloudflare/ai).
