// Bindings and secrets available to the Worker.
// Secrets (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY, GARMIN_API_KEY)
// are set in the Cloudflare dashboard, never in this repository.
interface __BaseEnv_Env {
	OAUTH_KV: KVNamespace;
	/** Public URL MCP clients connect to, e.g. https://garmin-mcp.<subdomain>.workers.dev/mcp */
	MCP_RESOURCE: string;
	/** The only GitHub login allowed to use this connector. */
	ALLOWED_GITHUB_LOGIN: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	GARMIN_API_KEY: string;
}
declare namespace Cloudflare {
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
