import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import {
	checkConnection,
	compact,
	getActivity,
	getActivityLaps,
	getActivityWorkouts,
	listActivities,
} from "./garmin";
import { isAllowedLogin, type Props } from "./utils";

const asText = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(compact(data) ?? null) }],
});

const asError = (e: unknown) => ({
	isError: true,
	content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

const activityId = z.number().int().positive().describe("Garmin activity ID (from list_activities)");

function createServer() {
	const server = new McpServer({ name: "Garmin (personal)", version: "0.1.0" });
	const props = getMcpAuthContext()?.props as Props | undefined;

	// Defense in depth: login is already restricted in the OAuth callback.
	if (!props || !isAllowedLogin(props.login)) return server;

	server.registerTool(
		"list_activities",
		{
			description:
				"List the owner's recent Garmin activities, newest first. Use activityType 'swimming' for swims. Dates are YYYY-MM-DD in the activity's local time.",
			inputSchema: z.object({
				startDate: z.string().optional().describe("Earliest start date, YYYY-MM-DD"),
				endDate: z.string().optional().describe("Latest start date, YYYY-MM-DD"),
				activityType: z
					.string()
					.optional()
					.describe("Parent activity type key, e.g. swimming, running, cycling"),
				limit: z.number().int().min(1).max(50).default(10),
			}),
		},
		async (args) => {
			try {
				return asText(await listActivities(args));
			} catch (e) {
				return asError(e);
			}
		},
	);

	server.registerTool(
		"get_activity",
		{
			description:
				"Summary of one Garmin activity, including totals and Garmin's split summaries (e.g. pool length, active lengths, strokes, SWOLF).",
			inputSchema: z.object({ activityId }),
		},
		async ({ activityId }) => {
			try {
				return asText(await getActivity(activityId));
			} catch (e) {
				return asError(e);
			}
		},
	);

	server.registerTool(
		"get_activity_laps",
		{
			description:
				"Every lap/interval of an activity read from its original FIT file: distance, time, pace per 100 m (seconds), strokes, SWOLF and heart rate. Rest intervals have isRest=true. Set includeLengths to also get each pool length.",
			inputSchema: z.object({
				activityId,
				includeLengths: z.boolean().default(false),
			}),
		},
		async ({ activityId, includeLengths }) => {
			try {
				return asText(await getActivityLaps(activityId, includeLengths));
			} catch (e) {
				return asError(e);
			}
		},
	);

	server.registerTool(
		"get_activity_workout",
		{
			description:
				"The planned workout linked to an activity, if it was done as a structured workout on the watch. Returns an empty list otherwise.",
			inputSchema: z.object({ activityId }),
		},
		async ({ activityId }) => {
			try {
				return asText(await getActivityWorkouts(activityId));
			} catch (e) {
				return asError(e);
			}
		},
	);

	server.registerTool(
		"check_garmin_connection",
		{
			description:
				"Check that the connector can get a Garmin access token and reach the Garmin API. Use when other tools fail.",
		},
		async () => {
			try {
				return asText(await checkConnection());
			} catch (e) {
				return asError(e);
			}
		},
	);

	return server;
}

const mcpHandler = createMcpHandler(createServer);
const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// The URL MCP clients connect to. Every token is bound to it.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
