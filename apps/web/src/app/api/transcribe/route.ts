import { webEnv } from "@opencut/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB (OpenAI limit)

export async function POST(request: NextRequest) {
	try {
		const { limited } = await checkRateLimit({ request });
		if (limited) {
			return NextResponse.json(
				{ error: "Too many requests" },
				{ status: 429 },
			);
		}

		if (!webEnv.OPENAI_API_KEY) {
			return NextResponse.json(
				{ error: "OPENAI_API_KEY not configured" },
				{ status: 500 },
			);
		}

		const formData = await request.formData();
		const file = formData.get("file") as File | null;
		const language = formData.get("language") as string | null;

		if (!file) {
			return NextResponse.json(
				{ error: "No audio file provided" },
				{ status: 400 },
			);
		}

		if (file.size > MAX_FILE_SIZE) {
			return NextResponse.json(
				{
					error: `File exceeds 25MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
				},
				{ status: 413 },
			);
		}

		const openaiForm = new FormData();
		openaiForm.append("file", file, "audio.wav");
		openaiForm.append("model", "whisper-1");
		openaiForm.append("response_format", "verbose_json");
		openaiForm.append("timestamp_granularities[]", "segment");
		if (language && language !== "auto") {
			openaiForm.append("language", language);
		}

		const response = await fetch(
			"https://api.openai.com/v1/audio/transcriptions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${webEnv.OPENAI_API_KEY}`,
				},
				body: openaiForm,
			},
		);

		if (!response.ok) {
			const errorText = await response.text();
			console.error("OpenAI Whisper API error:", response.status, errorText);
			return NextResponse.json(
				{ error: "OpenAI API error", details: errorText },
				{ status: response.status },
			);
		}

		const data = await response.json();

		return NextResponse.json({
			text: data.text,
			segments: (
				data.segments ?? []
			).map(
				(s: { text: string; start: number; end: number }) => ({
					text: s.text,
					start: s.start,
					end: s.end,
				}),
			),
			language: data.language ?? "unknown",
		});
	} catch (error) {
		console.error("Transcription error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
