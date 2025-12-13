import { Err, err, Ok, ok } from 'neverthrow';
import {
	Continuation,
	isTextRun,
	Json,
	JsonObject,
	Result,
	YTString,
} from './types';

// Shared headers to ensure we look like the same browser during scrape & fetch
export const COMMON_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+417;',
};

export type VideoData = {
	initialData: Json;
	config: YTConfig;
};

export type YTConfig = {
	INNERTUBE_API_KEY: string;
	INNERTUBE_CONTEXT: Json;
} & JsonObject;

export async function getVideoData(
	urls: string[]
): Promise<Ok<VideoData, unknown> | Err<unknown, [string, number]>> {
	let response: Response | undefined;
	
	// 1. Try to fetch the video page
	for (const url of urls) {
		try {
			console.log(`[SCRAPER] Fetching ${url}...`);
			response = await fetch(url, { headers: COMMON_HEADERS });
			if (response.ok) break;
		} catch (e) {
			console.error(`Failed to fetch ${url}`, e);
		}
	}

	if (!response || response.status === 404)
		return err(['Stream not found', 404]);
	
	if (!response.ok)
		return err(['Failed to fetch stream: ' + response.statusText, response.status]);

	const text = await response.text();
	console.log(`[SCRAPER] Page fetched. Length: ${text.length}`);

	// 2. PARSE INITIAL DATA (The video info)
	// We look for the variable, handling various spacing/quote styles
	const initialData = getMatch(
		text,
		/(?:var\s+ytInitialData|window\[['"]ytInitialData['"]\])\s*=\s*({[\s\S]+?});/
	);
	
	if (initialData.isErr()) {
		console.log("[SCRAPER] Failed to find standard ytInitialData, trying fallback...");
		const fallback = getMatch(text, /ytInitialData\s*=\s*({[\s\S]+?});/);
		if (fallback.isErr()) return initialData; // Propagate error if both fail
	}

	// 3. THE MAGNET: Find ALL ytcfg.set(...) blocks and merge them
	// YouTube splits config across multiple calls. We need ALL of them.
	const configRegex = /ytcfg\.set\s*\(\s*({[\s\S]+?})\s*\)\s*;/g;
	let configMatch;
	let mergedConfig: any = {};

	while ((configMatch = configRegex.exec(text)) !== null) {
		try {
			const part = JSON.parse(configMatch[1]);
			mergedConfig = { ...mergedConfig, ...part };
		} catch (e) {
			// Ignore malformed JSON parts
		}
	}

	// 4. Validate the merged config
	if (!mergedConfig.INNERTUBE_API_KEY) {
		return err(['Scraper failed: Could not find INNERTUBE_API_KEY in merged config', 500]);
	}
	
	// If context is missing, we can try to patch it, but usually the merge fixes it.
	if (!mergedConfig.INNERTUBE_CONTEXT) {
		console.log("[SCRAPER WARNING] INNERTUBE_CONTEXT missing. Attempting default...");
		mergedConfig.INNERTUBE_CONTEXT = {
			client: {
				hl: "en",
				gl: "US",
				clientName: "WEB",
				clientVersion: "2.20230920.00.00",
				userAgent: COMMON_HEADERS['User-Agent'],
				osName: "Windows",
				osVersion: "10.0",
			}
		};
	}

	return ok({ initialData: initialData.value, config: mergedConfig });
}

function getMatch<T extends Json = Json>(
	html: string,
	pattern: RegExp
): Result<T, [string, number]> {
	const match = pattern.exec(html);
	if (!match?.[1]) return err(['Failed to find video data pattern', 404]);
	try {
		return ok(JSON.parse(match[1]));
	} catch {
		return err(['Failed to parse video data JSON', 500]);
	}
}

export function getContinuationToken(continuation: Continuation) {
	const key = Object.keys(continuation)[0] as keyof Continuation;
	return continuation[key]?.continuation;
}

export function parseYTString(string?: YTString): string {
	if (!string) return '';
	if (string.simpleText) return string.simpleText;
	if (string.runs)
		return string.runs
			.map((run) => {
				if (isTextRun(run)) {
					return run.text;
				} else {
					if (run.emoji.isCustomEmoji) {
						return ` ${
							run.emoji.image.accessibility?.accessibilityData?.label ??
							run.emoji.searchTerms[1] ??
							run.emoji.searchTerms[0]
						} `;
					} else {
						return run.emoji.emojiId;
					}
				}
			})
			.join('')
			.trim();
	return '';
}
