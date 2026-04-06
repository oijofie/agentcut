import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Load .env from packages/mcp-server/.env
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env file is optional
}

const WS_PORT = process.env.WS_PORT || "3001";
const WS_BRIDGE_URL = `ws://localhost:${WS_PORT}/ws?role=mcp`;

// Resolve ffmpeg/ffprobe paths (homebrew may not be in MCP server PATH)
const FFMPEG_CANDIDATES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
function findBin(name: string): string {
  for (const dir of FFMPEG_CANDIDATES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return name;
}
const FFMPEG = findBin("ffmpeg");
const FFPROBE = findBin("ffprobe");

// --- WebSocket Bridge Client ---

let ws: WebSocket | null = null;
const pendingRequests = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
let requestCounter = 0;

function connectWs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    ws = new WebSocket(WS_BRIDGE_URL);

    ws.on("open", () => {
      console.error("[mcp] connected to ws-bridge");
      resolve();
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          pendingRequests.delete(msg.id);
          if (msg.ok) {
            pending.resolve(msg.data ?? null);
          } else {
            pending.reject(new Error(msg.error ?? "Unknown error"));
          }
        }
      } catch (e) {
        console.error("[mcp] failed to parse ws message:", e);
      }
    });

    ws.on("close", () => {
      console.error("[mcp] ws-bridge disconnected");
      ws = null;
      // Reject all pending requests
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error("WebSocket disconnected"));
        pendingRequests.delete(id);
      }
    });

    ws.on("error", (err) => {
      console.error("[mcp] ws error:", err.message);
      reject(err);
    });
  });
}

async function sendCommand(type: string, params?: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
  await connectWs();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to ws-bridge. Is OpenCut running?");
  }

  const id = `mcp-${++requestCounter}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Command timed out (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    ws!.send(JSON.stringify({ id, type, params }));
  });
}

// --- MCP Server ---

const server = new McpServer({
  name: "opencut",
  version: "0.1.0",
});

server.tool(
  "get_timeline",
  "Get the current timeline state including tracks, elements, playback position",
  async () => {
    const data = await sendCommand("get_timeline");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "split",
  "Split all clips at the specified time (seconds)",
  { time: z.number().describe("Time in seconds where to split") },
  async ({ time }) => {
    const data = await sendCommand("split", { time });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "remove_range",
  "Remove all content between start and end time (seconds). Splits at boundaries then deletes elements in range.",
  {
    start: z.number().describe("Start time in seconds"),
    end: z.number().describe("End time in seconds"),
  },
  async ({ start, end }) => {
    const data = await sendCommand("remove_range", { start, end });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "trim",
  "Adjust the trim (in/out points) of a specific element",
  {
    elementId: z.string().describe("ID of the element to trim"),
    trimStart: z.number().optional().describe("New trim start offset in seconds"),
    trimEnd: z.number().optional().describe("New trim end offset in seconds"),
    startTime: z.number().optional().describe("New start time on the timeline"),
    duration: z.number().optional().describe("New visible duration"),
  },
  async ({ elementId, trimStart, trimEnd, startTime, duration }) => {
    const data = await sendCommand("trim", { elementId, trimStart, trimEnd, startTime, duration });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "undo",
  "Undo the last editing operation",
  async () => {
    const data = await sendCommand("undo");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "redo",
  "Redo the last undone operation",
  async () => {
    const data = await sendCommand("redo");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "seek",
  "Seek the playhead to a specific time",
  { time: z.number().describe("Time in seconds to seek to") },
  async ({ time }) => {
    const data = await sendCommand("seek", { time });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "play",
  "Start playback",
  async () => {
    const data = await sendCommand("play");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "pause",
  "Pause playback",
  async () => {
    const data = await sendCommand("pause");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "add_effect",
  "Add an effect to a specific element or as an effect layer on the timeline",
  {
    effectType: z.string().describe("Effect type (e.g. 'blur', 'letterbox')"),
    elementId: z.string().optional().describe("Target element ID. If omitted, adds as effect layer covering the full timeline"),
    trackId: z.string().optional().describe("Track ID of the target element (required when elementId is provided)"),
    params: z.record(z.string(), z.number().or(z.string()).or(z.boolean())).optional().describe("Effect parameters (e.g. { amount: 12, color: '#000000' })"),
  },
  async ({ effectType, elementId, trackId, params }) => {
    const data = await sendCommand("add_effect", { effectType, elementId, trackId, params });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "set_canvas_size",
  "Change the project canvas size (e.g. 1080x1920 for vertical 9:16, 1920x1080 for horizontal 16:9)",
  {
    width: z.number().describe("Canvas width in pixels"),
    height: z.number().describe("Canvas height in pixels"),
  },
  async ({ width, height }) => {
    const data = await sendCommand("set_canvas_size", { width, height });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "add_text",
  "Add a text element to the timeline. Use position 'top'/'bottom' to place text on letterbox bar area.",
  {
    content: z.string().describe("Text content to display"),
    position: z.enum(["center", "top", "bottom"]).optional().describe("Preset position. 'top'/'bottom' places text on letterbox bar area. Default: center"),
    x: z.number().optional().describe("X offset from center in pixels (overrides position preset for X)"),
    y: z.number().optional().describe("Y offset from center in pixels (overrides position preset for Y)"),
    fontSize: z.number().optional().describe("Font size (default: 15, scaled by canvas height)"),
    color: z.string().optional().describe("Text color hex (default: #ffffff)"),
    startTime: z.number().optional().describe("Start time on timeline in seconds (default: 0)"),
    duration: z.number().optional().describe("Duration in seconds (default: full timeline duration)"),
  },
  async ({ content, position, x, y, fontSize, color, startTime, duration }) => {
    const data = await sendCommand("add_text", { content, position, x, y, fontSize, color, startTime, duration });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "add_image",
  "Add an image (from the project's media assets) as an overlay on the timeline",
  {
    mediaId: z.string().describe("ID of the image asset"),
    startTime: z.coerce.number().optional().describe("Start time on timeline in seconds (default: 0)"),
    duration: z.coerce.number().optional().describe("Duration in seconds (default: full timeline duration)"),
    x: z.coerce.number().optional().describe("X offset from center in pixels (default: 0)"),
    y: z.coerce.number().optional().describe("Y offset from center in pixels (default: 0)"),
    opacity: z.coerce.number().optional().describe("Opacity 0-1 (default: 1)"),
    scale: z.coerce.number().optional().describe("Scale factor (default: 1.0, e.g. 0.5 = half size, 2.0 = double)"),
  },
  async ({ mediaId, startTime, duration, x, y, opacity, scale }) => {
    const data = await sendCommand("add_image", { mediaId, startTime, duration, x, y, opacity, scale });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "transcribe_api",
  "Transcribe the timeline audio using OpenAI Whisper API. Returns word-level timestamps.",
  {
    language: z.string().optional().describe("Language code (e.g. 'ja', 'en'). Auto-detected if omitted."),
  },
  async ({ language }) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { content: [{ type: "text", text: "Error: OPENAI_API_KEY environment variable is not set" }] };
    }

    // Extract audio from browser (60s timeout for long timelines)
    const result = await sendCommand("extract_audio", {}, 180000) as { audio: string; duration: number };

    // Decode base64 WAV
    const wavBuffer = Buffer.from(result.audio, "base64");
    const wavFile = new File([wavBuffer], "audio.wav", { type: "audio/wav" });

    // Call Whisper API
    const openai = new OpenAI({ apiKey });
    const transcription = await openai.audio.transcriptions.create({
      file: wavFile,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
      ...(language ? { language } : {}),
    });

    const words = (transcription as unknown as { words?: Array<{ word: string; start: number; end: number }> }).words ?? [];

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          text: transcription.text,
          language: transcription.language,
          duration: result.duration,
          words,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "detect_scenes",
  "Detect scene changes using ffmpeg scdet filter. Can analyze a local file (file_path) or the current timeline.",
  {
    threshold: z.number().min(0).max(100).optional().describe(
      "Scene change detection sensitivity (0-100). Lower = more sensitive. Default: 10",
    ),
    file_path: z.string().optional().describe(
      "Absolute path to a local video file. If omitted, exports and analyzes the current timeline.",
    ),
  },
  async ({ threshold, file_path }) => {
    const t = threshold ?? 10;

    let inputFile: string;
    let tmpDir: string | null = null;
    let duration: number;

    if (file_path) {
      // Use local file directly
      if (!existsSync(file_path)) {
        return {
          content: [{
            type: "text",
            text: `File not found: ${file_path}`,
          }],
          isError: true,
        };
      }
      inputFile = file_path;

      // Get duration via ffprobe
      duration = await new Promise<number>((resolve, reject) => {
        execFile(
          FFPROBE,
          ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file_path],
          (err, stdout) => {
            if (err) reject(new Error(`ffprobe failed: ${err.message}`));
            else resolve(Number.parseFloat(stdout.trim()) || 0);
          },
        );
      });
    } else {
      // Export timeline video from browser
      const result = await sendCommand("extract_video", {}, 300000) as {
        video: string;
        duration: number;
      };
      duration = result.duration;
      tmpDir = mkdtempSync(join(tmpdir(), "opencut-"));
      inputFile = join(tmpDir, "input.mp4");
      writeFileSync(inputFile, Buffer.from(result.video, "base64"));
    }

    try {
      // Run ffmpeg scdet
      const stderr = await new Promise<string>((resolve, reject) => {
        execFile(
          FFMPEG,
          ["-hide_banner", "-i", inputFile, "-vf", `scdet=t=${t}:sc_pass=1`, "-f", "null", "-"],
          { maxBuffer: 10 * 1024 * 1024 },
          (err, _stdout, stderr) => {
            if (err && !stderr) {
              reject(new Error(`ffmpeg failed: ${err.message}`));
            } else {
              resolve(stderr);
            }
          },
        );
      });

      // Parse scene timestamps
      const boundaries: number[] = [];
      const regex = /lavfi\.scd\.time:\s*([\d.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(stderr)) !== null) {
        boundaries.push(Number.parseFloat(match[1]));
      }

      // Convert boundaries to cuts
      const cuts: Array<{ start: number; end: number }> = [];
      let prev = 0;
      for (const boundary of boundaries) {
        cuts.push({ start: prev, end: boundary });
        prev = boundary;
      }
      if (prev < duration) {
        cuts.push({ start: prev, end: duration });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            cuts,
            threshold: t,
            count: cuts.length,
            duration,
          }, null, 2),
        }],
      };
    } finally {
      if (tmpDir) {
        try { unlinkSync(join(tmpDir, "input.mp4")); } catch {}
        try { unlinkSync(tmpDir); } catch {}
      }
    }
  },
);

server.tool(
  "list_media",
  "List all media assets in the current project",
  async () => {
    const data = await sendCommand("list_media");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "transcribe_local",
  "Transcribe the timeline audio using local Whisper model in the browser. Returns text with timestamped segments.",
  {
    language: z
      .enum(["auto", "en", "es", "it", "fr", "de", "pt", "ru", "ja", "zh"])
      .optional()
      .describe("Language for transcription (default: auto-detect)"),
    model: z
      .enum([
        "whisper-tiny",
        "whisper-small",
        "whisper-medium",
        "whisper-large-v3-turbo",
      ])
      .optional()
      .describe("Whisper model to use (default: whisper-small)"),
  },
  async ({ language, model }) => {
    const data = await sendCommand(
      "transcribe_video",
      { language, model },
      300000,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_video_labels",
  "Retrieve previously saved labels for a video",
  {
    mediaId: z.string().describe("ID of the media asset"),
  },
  async ({ mediaId }) => {
    const data = await sendCommand("get_video_labels", { mediaId });
    if (!data) {
      return { content: [{ type: "text", text: `No labels found for media ${mediaId}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
	"create_video_labels",
	"Analyze video using Google Gemini API. Uploads video to Gemini, performs scene-by-scene labeling with structured output, and saves labels.",
	{
		mediaId: z.string().describe("ID of the media asset to label"),
		file_path: z.string().optional().describe("Absolute path to a local video file. If omitted, exports from the current timeline."),
		model: z.string().optional().describe("Gemini model name (default: gemini-3-flash-preview)"),
	},
	async ({ mediaId, file_path, model }) => {
		const apiKey = process.env.GEMINI_API_KEY;
		if (!apiKey) {
			return { content: [{ type: "text", text: "Error: GEMINI_API_KEY environment variable is not set" }], isError: true };
		}

		const modelName = model ?? process.env.GEMINI_MODEL!;
		let inputFile: string;
		let tmpDir: string | null = null;
		let duration = 0;
		let resolution = "";
		let fps = 0;
		const log = (msg: string) => console.error(`[create_video_labels] ${msg} (${(performance.now() / 1000).toFixed(1)}s)`);

		log("start");

		if (file_path) {
			if (!existsSync(file_path)) {
				return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true };
			}
			inputFile = file_path;
			log(`using file_path: ${file_path}`);
		} else {
			log("extracting video from browser...");
			const result = await sendCommand("extract_video", {}, 300000) as { video: string; duration: number };
			duration = result.duration;
			tmpDir = mkdtempSync(join(tmpdir(), "opencut-gemini-"));
			inputFile = join(tmpDir, "input.mp4");
			writeFileSync(inputFile, Buffer.from(result.video, "base64"));
			log("video extracted from browser");
		}

		try {
			// Get video metadata via ffprobe
			log("running ffprobe...");
			const probeResult = await new Promise<string>((res, rej) => {
				execFile(
					FFPROBE,
					["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,duration", "-show_entries", "format=duration", "-of", "json", inputFile],
					(err, stdout) => err ? rej(new Error(`ffprobe failed: ${err.message}`)) : res(stdout),
				);
			});
			const probe = JSON.parse(probeResult);
			const stream = probe.streams?.[0];
			if (stream) {
				resolution = `${stream.width}x${stream.height}`;
				const [num, den] = (stream.r_frame_rate ?? "0/1").split("/");
				fps = Math.round(Number(num) / Number(den));
			}
			if (!duration) {
				duration = Number.parseFloat(stream?.duration ?? probe.format?.duration ?? "0");
			}
			log(`ffprobe done: ${resolution}, ${fps}fps, ${duration.toFixed(1)}s`);

			// Upload to Gemini File API
			log("uploading to Gemini...");
			const genai = new GoogleGenAI({ apiKey });
			const uploaded = await genai.files.upload({ file: inputFile, config: { mimeType: "video/mp4" } });
			let file = uploaded;
			log(`upload complete, state=${uploaded.state}`);
			let pollCount = 0;
			while (file.state === "PROCESSING") {
				if (++pollCount > 120) throw new Error("Gemini file processing timed out (10 min)");
				await new Promise((r) => setTimeout(r, 5000));
				file = await genai.files.get({ name: file.name! });
				if (pollCount % 6 === 0) log(`still processing... (poll #${pollCount})`);
			}
			if (file.state !== "ACTIVE") {
				throw new Error(`Gemini file upload failed: state=${file.state}`);
			}
			log("file active, calling Gemini model...");

			// Call Gemini with structured output
			const labelsSchema = {
				type: "object",
				properties: {
					summary: { type: "string" },
					overallTone: { type: "string" },
					speakers: { type: "array", items: { type: "string" } },
					scenes: {
						type: "array",
						items: {
							type: "object",
							properties: {
								startTime: { type: "number" },
								endTime: { type: "number" },
								description: { type: "string" },
								category: { type: "string" },
								score: { type: "number" },
								audioType: { type: "string", enum: ["speech", "music", "silence", "noise", "mixed"] },
								speechContent: { type: "string" },
								speaker: { type: "string" },
								visualQuality: { type: "string", enum: ["good", "fair", "poor"] },
								cameraMovement: { type: "string", enum: ["static", "pan", "zoom", "handheld"] },
								energyLevel: { type: "number" },
								isHighlight: { type: "boolean" },
							},
							required: ["startTime", "endTime", "description", "audioType", "visualQuality", "cameraMovement", "energyLevel", "isHighlight"],
						},
					},
				},
				required: ["summary", "overallTone", "speakers", "scenes"],
			};

			const prompt = `この動画の内容を解析し、シーンごとに分割してラベリングしてください。

ルール:
- 動画全体を隙間なくシーンに分割してください（最初のシーンのstartTime=0、最後のシーンのendTime=動画の終了時刻）
- startTime, endTimeは秒数（小数点OK）で返してください
- descriptionに、そのシーンの具体的な内容を詳しく記述してください（誰が何をしているか、何を話しているか）
- categoryに、内容のカテゴリを記述してください（例: リアクション、名言、議論、ハプニング、雑談、企画説明 等）
- scoreに、切り抜き動画としての面白さ・バズりやすさを1-10で評価してください（10が最も面白い）
- audioTypeに、音声の種類を分類してください
- speechContentに、発言内容を書き起こしてください（なければ空文字列）
- speakerに、話者を特定してください（なければ空文字列）
- visualQualityに、映像品質を評価してください
- cameraMovementに、カメラの動きを分類してください
- energyLevelに、シーンのエネルギーレベルを1-5で評価してください
- isHighlightに、特に面白い・注目すべきシーンかどうかをtrue/falseで返してください
- summaryに、動画全体の概要を記述してください
- overallToneに、動画全体のトーンを記述してください
- speakersに、動画に登場する話者の一覧を返してください`;

			const response = await genai.models.generateContent({
				model: modelName,
				contents: [
					{
						role: "user",
						parts: [
							{ fileData: { fileUri: file.uri!, mimeType: "video/mp4" } },
							{ text: prompt },
						],
					},
				],
				config: {
					temperature: 0.1,
					maxOutputTokens: 65536,
					responseMimeType: "application/json",
					responseSchema: labelsSchema,
				},
			});

			log("Gemini response received");
			const parsed = JSON.parse(response.text!);
			log(`parsed: ${parsed.scenes?.length ?? 0} scenes`);

			const labels = {
				mediaId,
				version: 1,
				createdAt: new Date().toISOString(),
				global: {
					duration,
					resolution,
					fps,
					summary: parsed.summary,
					overallTone: parsed.overallTone,
					speakers: parsed.speakers,
				},
				scenes: parsed.scenes,
			};

			// Save via WebSocket
			log("saving labels...");
			await sendCommand("save_video_labels", { labels });

			// Cleanup Gemini file
			await genai.files.delete({ name: file.name! }).catch(() => {});

			log("done!");
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						success: true,
						mediaId,
						model: modelName,
						sceneCount: parsed.scenes.length,
						duration,
						resolution,
						summary: parsed.summary,
					}, null, 2),
				}],
			};
		} finally {
			if (tmpDir) {
				try { unlinkSync(join(tmpDir, "input.mp4")); } catch {}
				try { unlinkSync(tmpDir); } catch {}
			}
		}
	},
);

server.tool(
  "clip_recommendation",
  "Retrieve and structure labeled scene data for clip candidate recommendation. Returns ranked scenes with context for AI analysis.",
  {
    mediaId: z.string().describe("ID of the media asset"),
    minDuration: z
      .number()
      .optional()
      .describe("Minimum clip duration in seconds (default: 3)"),
    maxDuration: z
      .number()
      .optional()
      .describe("Maximum clip duration in seconds (default: 60)"),
    purpose: z
      .string()
      .optional()
      .describe(
        "Intended use: 'highlight_reel', 'social_short', 'recap' (default: highlight_reel)"
      ),
  },
  async ({ mediaId, minDuration, maxDuration, purpose }) => {
    const min = minDuration ?? 3;
    const max = maxDuration ?? 60;
    const clipPurpose = purpose ?? "highlight_reel";

    const result = (await sendCommand("get_video_labels", {
      mediaId,
    })) as {
      global?: {
        duration: number;
        resolution: string;
        fps: number;
        summary: string;
        overallTone: string;
        speakers: string[];
      };
      scenes?: Array<{
        startTime: number;
        endTime: number;
        description: string;
        category?: string;
        score?: number;
        speechContent?: string;
        speaker?: string;
        isHighlight?: boolean;
        audioType?: string;
        energyLevel?: number;
        visualQuality?: string;
        cameraMovement?: string;
      }>;
    } | null;

    if (!result?.scenes || result.scenes.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No labels found for media ${mediaId}. Run labeling first.`,
          },
        ],
        isError: true,
      };
    }

    const { global, scenes } = result;

    const chronologicalScenes = scenes.map((scene, i) => {
      const duration = scene.endTime - scene.startTime;
      return {
        index: i,
        startTime: scene.startTime,
        endTime: scene.endTime,
        duration,
        description: scene.description,
        score: scene.score ?? 0,
        isHighlight: scene.isHighlight ?? false,
        filteredOut: duration < min || duration > max,
      };
    });

    const eligible = scenes
      .map((scene, i) => ({ scene, index: i }))
      .filter((entry) => {
        const duration =
          entry.scene.endTime - entry.scene.startTime;
        return duration >= min && duration <= max;
      });

    eligible.sort((a, b) => {
      const aHighlight = a.scene.isHighlight ? 1 : 0;
      const bHighlight = b.scene.isHighlight ? 1 : 0;
      if (bHighlight !== aHighlight) return bHighlight - aHighlight;
      return (b.scene.score ?? 0) - (a.scene.score ?? 0);
    });

    const rankedScenes = eligible.map((entry, rank) => {
      const { scene, index } = entry;
      const prev = index > 0 ? scenes[index - 1] : null;
      const next =
        index < scenes.length - 1 ? scenes[index + 1] : null;
      return {
        rank: rank + 1,
        index,
        startTime: scene.startTime,
        endTime: scene.endTime,
        duration: scene.endTime - scene.startTime,
        timeRange: `${fmtTime(scene.startTime)} - ${fmtTime(scene.endTime)}`,
        description: scene.description,
        category: scene.category ?? "",
        score: scene.score ?? 0,
        isHighlight: scene.isHighlight ?? false,
        audioType: scene.audioType,
        energyLevel: scene.energyLevel,
        visualQuality: scene.visualQuality,
        cameraMovement: scene.cameraMovement,
        speechContent: scene.speechContent,
        speaker: scene.speaker,
        context: {
          prevScene: prev
            ? {
                timeRange: `${fmtTime(prev.startTime)} - ${fmtTime(prev.endTime)}`,
                description: prev.description,
              }
            : null,
          nextScene: next
            ? {
                timeRange: `${fmtTime(next.startTime)} - ${fmtTime(next.endTime)}`,
                description: next.description,
              }
            : null,
        },
      };
    });

    const scores = scenes.map((s) => s.score ?? 0);
    const highlightCount = scenes.filter(
      (s) => s.isHighlight
    ).length;
    const averageScore =
      scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;

    const output = {
      mediaId,
      purpose: clipPurpose,
      global: {
        ...(global ?? {
          duration: 0,
          resolution: "",
          fps: 0,
          summary: "",
          overallTone: "",
          speakers: [],
        }),
        totalScenes: scenes.length,
        highlightCount,
        averageScore: Math.round(averageScore * 100) / 100,
      },
      rankedScenes,
      chronologicalScenes,
      instructions:
        "You are given labeled scenes for a video. Select 3-5 best clip candidates from rankedScenes. For each, explain why it works as a clip and suggest trim points if needed. Consider narrative flow using adjacent scene context.",
    };

    return {
      content: [
        { type: "text", text: JSON.stringify(output, null, 2) },
      ],
    };
  }
);

server.tool(
	"clip_create",
	"Split the timeline at the start and end of a scene to create a clip boundary (razor cut). Does not remove anything.",
	{
		startTime: z.number().describe("Start time of the clip in seconds"),
		endTime: z.number().describe("End time of the clip in seconds"),
	},
	async ({ startTime, endTime }) => {
		const startResult = await sendCommand("split", { time: startTime });
		const endResult = await sendCommand("split", { time: endTime });
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						splits: [
							{ time: startTime, result: startResult },
							{ time: endTime, result: endResult },
						],
					}),
				},
			],
		};
	}
);

function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

server.tool(
  "generate_scene_md",
  "Generate a single markdown file with per-scene detailed breakdown from saved video labels.",
  {
    mediaId: z.string().describe("ID of the media asset"),
    outputPath: z.string().describe("Absolute path to output .md file"),
  },
  async ({ mediaId, outputPath }) => {
    // Get labels from browser
    const result = await sendCommand("get_video_labels", { mediaId }) as {
      id?: string;
      mediaId?: string;
      version?: number;
      global?: {
        duration: number;
        resolution: string;
        fps: number;
        summary: string;
        overallTone: string;
        speakers: string[];
      };
      scenes?: Array<{
        startTime: number;
        endTime: number;
        description: string;
        category?: string;
        score?: number;
        speechContent?: string;
        speaker?: string;
        isHighlight?: boolean;
      }>;
    } | null;

    if (!result?.scenes || result.scenes.length === 0) {
      return {
        content: [{ type: "text", text: `No labels found for media ${mediaId}. Run labeling first.` }],
        isError: true,
      };
    }

    // Create parent directory if needed
    const outputDir = dirname(outputPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const { global, scenes } = result;

    const lines = [
      `# ${global?.summary || mediaId} — シーン別やりとり詳細`,
      "",
    ];

    for (const scene of scenes) {
      const timeRange = `${fmtTime(scene.startTime)}〜${fmtTime(scene.endTime)}`;
      const title = scene.category || "シーン";
      lines.push(`## ${timeRange} — ${title}`);
      lines.push("");

      // Split description into bullet points by sentence
      const sentences = scene.description
        .split(/(?<=[。！？\n])|(?<=\. )/g)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);

      for (const sentence of sentences) {
        lines.push(`- ${sentence}`);
      }

      if (scene.speechContent) {
        lines.push(`- 発言: 「${scene.speechContent}」`);
      }

      lines.push("");
    }

    writeFileSync(outputPath, lines.join("\n"));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          outputPath,
          sceneCount: scenes.length,
        }, null, 2),
      }],
    };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] OpenCut MCP server started");
}

main().catch((err) => {
  console.error("[mcp] Fatal error:", err);
  process.exit(1);
});
