import { env } from "cloudflare:workers";
import { Decoder, Stream } from "@garmin/fitsdk";
import { unzipSync } from "fflate";

const BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_URL = `${BASE_URL}/personalapitoken-service/personal-api/personal-api-key/token`;
const TOKEN_CACHE_KEY = "garmin:access_token";
// Garmin access tokens are valid for 24 hours. Refresh well before that.
const DEFAULT_TOKEN_TTL_SECONDS = 23 * 60 * 60;

/** Exchange the personal API key for a short-lived access token. */
async function requestNewToken(): Promise<{ token: string; ttl: number }> {
	if (!env.GARMIN_API_KEY) {
		throw new Error("GARMIN_API_KEY is not set in the Worker's secrets.");
	}
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { Authorization: `ApiKey ${env.GARMIN_API_KEY}` },
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Garmin token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
	}

	// The response format is not documented, so accept the common shapes.
	let token: string | undefined;
	let ttl = DEFAULT_TOKEN_TTL_SECONDS;
	try {
		const json = JSON.parse(text) as Record<string, unknown>;
		const candidate = json.access_token ?? json.accessToken ?? json.token;
		if (typeof candidate === "string") token = candidate;
		const expiresIn = json.expires_in ?? json.expiresIn;
		if (typeof expiresIn === "number" && expiresIn > 0) {
			ttl = Math.min(ttl, expiresIn);
		}
		if (!token) {
			throw new Error(
				`No access token found in Garmin's token response. Response keys: ${Object.keys(json).join(", ")}`,
			);
		}
	} catch (e) {
		if (e instanceof SyntaxError) {
			// Not JSON: treat the body as the token itself.
			token = text.trim();
		} else {
			throw e;
		}
	}
	if (!token) throw new Error("Garmin returned an empty token.");
	return { token, ttl };
}

async function getAccessToken(forceRefresh = false): Promise<string> {
	if (!forceRefresh) {
		const cached = await env.OAUTH_KV.get(TOKEN_CACHE_KEY);
		if (cached) return cached;
	}
	const { token, ttl } = await requestNewToken();
	// Expire the cache 10 minutes before Garmin does (KV minimum TTL is 60 s).
	await env.OAUTH_KV.put(TOKEN_CACHE_KEY, token, { expirationTtl: Math.max(60, ttl - 600) });
	return token;
}

type Query = Record<string, string | number | boolean | undefined>;

async function garminFetch(path: string, query: Query = {}): Promise<Response> {
	const url = new URL(path, BASE_URL);
	for (const [k, v] of Object.entries(query)) {
		if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
	}
	const doFetch = (token: string) =>
		fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });

	let res = await doFetch(await getAccessToken());
	if (res.status === 401) {
		// Cached token may have expired or been revoked: get a fresh one and retry once.
		res = await doFetch(await getAccessToken(true));
	}
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Garmin API ${url.pathname} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
	}
	return res;
}

async function garminJson(path: string, query: Query = {}): Promise<unknown> {
	return (await garminFetch(path, query)).json();
}

/** Remove null, undefined, empty arrays and empty objects to keep tool output small. */
export function compact(value: unknown): unknown {
	if (Array.isArray(value)) {
		const arr = value.map(compact).filter((v) => v !== undefined);
		return arr.length ? arr : undefined;
	}
	if (value && typeof value === "object" && !(value instanceof Date)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const c = compact(v);
			if (c !== undefined) out[k] = c;
		}
		return Object.keys(out).length ? out : undefined;
	}
	if (value === null || value === undefined) return undefined;
	return value;
}

export async function listActivities(params: {
	startDate?: string;
	endDate?: string;
	activityType?: string;
	limit?: number;
}) {
	return garminJson("/activitylist-service/activities/search/activities", {
		startDate: params.startDate,
		endDate: params.endDate,
		activityType: params.activityType,
		limit: params.limit ?? 10,
		start: 0,
		sortOrder: "desc",
	});
}

export async function getActivity(activityId: number) {
	return garminJson(`/activity-service/activity/${activityId}`);
}

export async function getActivityWorkouts(activityId: number) {
	return garminJson(`/activity-service/activity/${activityId}/workouts`);
}

/** Download the original activity file (a zip holding the FIT file) and return the FIT bytes. */
async function downloadFit(activityId: number): Promise<Uint8Array> {
	const res = await garminFetch(`/download-service/files/activity/${activityId}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	// Zip files start with "PK".
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
		const files = unzipSync(bytes);
		const fitName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".fit"));
		if (!fitName) {
			throw new Error(`No .fit file in the downloaded zip. Files: ${Object.keys(files).join(", ")}`);
		}
		return files[fitName];
	}
	return bytes;
}

const round = (n: unknown, digits = 1) =>
	typeof n === "number" ? Math.round(n * 10 ** digits) / 10 ** digits : undefined;

/** Seconds per 100 m from a speed in m/s. */
const pacePer100m = (speed: unknown) =>
	typeof speed === "number" && speed > 0 ? round(100 / speed, 1) : undefined;

type FitMessage = Record<string, unknown>;

/**
 * Laps (intervals) and pool lengths from the activity's FIT file.
 * Times are in seconds, distances in metres, pace in seconds per 100 m.
 */
export async function getActivityLaps(activityId: number, includeLengths: boolean) {
	const fit = await downloadFit(activityId);
	const decoder = new Decoder(Stream.fromByteArray(Array.from(fit)));
	if (!decoder.isFIT()) throw new Error("The downloaded file is not a valid FIT file.");
	const { messages, errors } = decoder.read({ mergeHeartRates: false });

	const sessions = (messages.sessionMesgs ?? []) as FitMessage[];
	const laps = (messages.lapMesgs ?? []) as FitMessage[];
	const lengths = (messages.lengthMesgs ?? []) as FitMessage[];

	const session = sessions[0];
	const lapRows = laps.map((lap, i) => {
		const first = typeof lap.firstLengthIndex === "number" ? lap.firstLengthIndex : undefined;
		const count = typeof lap.numLengths === "number" ? lap.numLengths : 0;
		const lapLengths =
			includeLengths && first !== undefined
				? lengths.slice(first, first + count).map((len, j) => ({
						length: j + 1,
						type: len.lengthType,
						stroke: len.swimStroke,
						elapsedSec: round(len.totalElapsedTime),
						timerSec: round(len.totalTimerTime),
						strokes: len.totalStrokes,
						pacePer100mSec: pacePer100m(len.avgSpeed),
					}))
				: undefined;
		const speed = lap.enhancedAvgSpeed ?? lap.avgSpeed;
		return {
			lap: i + 1,
			startTime: lap.startTime,
			// Laps with no distance are usually rest intervals in pool swims.
			isRest: !lap.totalDistance,
			distanceM: round(lap.totalDistance, 0),
			elapsedSec: round(lap.totalElapsedTime),
			timerSec: round(lap.totalTimerTime),
			pacePer100mSec: pacePer100m(speed),
			stroke: lap.swimStroke,
			activeLengths: lap.numActiveLengths,
			strokes: lap.totalCycles,
			avgStrokesPerLength: round(lap.avgStrokesPerLength),
			avgSwolf: lap.avgSwolf,
			avgHeartRate: lap.avgHeartRate,
			maxHeartRate: lap.maxHeartRate,
			intensity: lap.intensity,
			lapTrigger: lap.lapTrigger,
			lengths: lapLengths,
		};
	});

	return compact({
		activityId,
		session: session && {
			sport: session.sport,
			subSport: session.subSport,
			startTime: session.startTime,
			poolLength: session.poolLength,
			poolLengthUnit: session.poolLengthUnit,
			distanceM: round(session.totalDistance, 0),
			elapsedSec: round(session.totalElapsedTime),
			timerSec: round(session.totalTimerTime),
			avgHeartRate: session.avgHeartRate,
			maxHeartRate: session.maxHeartRate,
			numLaps: session.numLaps,
			numActiveLengths: session.numActiveLengths,
		},
		laps: lapRows,
		decodeWarnings: errors?.length ? errors.map(String).slice(0, 5) : undefined,
	});
}

/** Quick health check: can we get a token and reach the API? */
export async function checkConnection() {
	await getAccessToken(true);
	const activities = (await listActivities({ limit: 1 })) as unknown;
	return {
		tokenOk: true,
		apiOk: true,
		sampleType: Array.isArray(activities) ? "array" : typeof activities,
	};
}
