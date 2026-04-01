import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import OpenAI from "openai";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, existsSync } from "node:fs";
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

const WS_BRIDGE_URL = "ws://localhost:3001/ws?role=mcp";

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
  "transcribe",
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
  "get_video_frames",
  "Extract frames from a video at regular intervals as base64 JPEG images. Use for AI vision analysis.",
  {
    mediaId: z.string().describe("ID of the media asset to extract frames from"),
    interval: z.number().optional().describe("Interval in seconds between frames (default: 5)"),
  },
  async ({ mediaId, interval }) => {
    const data = await sendCommand("get_video_frames", { mediaId, interval }, 300000) as {
      frames: Array<{ time: number; image: string }>;
      mediaId: string;
      interval: number;
    };

    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
    content.push({ type: "text", text: `Extracted ${data.frames.length} frames from media ${mediaId} at ${data.interval}s intervals` });

    for (const frame of data.frames) {
      content.push({ type: "text", text: `--- Frame at ${frame.time.toFixed(1)}s ---` });
      content.push({ type: "image", data: frame.image, mimeType: "image/jpeg" });
    }

    return { content };
  },
);

server.tool(
  "transcribe_video",
  "Transcribe the timeline audio using Whisper. Returns text with timestamped segments.",
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
  "save_video_labels",
  "Save AI-generated labels (metadata) for a video. Labels include scene-level descriptions, audio type, energy level, etc.",
  {
    labels: z
      .object({
        mediaId: z.string().describe("ID of the media asset"),
        version: z.number().describe("Label schema version"),
        createdAt: z.string().describe("ISO timestamp"),
        global: z.object({
          duration: z.number(),
          resolution: z.string(),
          fps: z.number(),
          summary: z.string(),
          overallTone: z.string(),
          speakers: z.array(z.string()),
        }).describe("Global video metadata"),
        scenes: z.array(z.object({
          startTime: z.number(),
          endTime: z.number(),
          description: z.string(),
          category: z.string().optional(),
          score: z.number().optional(),
          audioType: z.enum(["speech", "music", "silence", "noise", "mixed"]).optional(),
          speechContent: z.string().optional(),
          speaker: z.string().optional(),
          visualQuality: z.enum(["good", "fair", "poor"]).optional(),
          cameraMovement: z.enum(["static", "pan", "zoom", "handheld"]).optional(),
          energyLevel: z.number().min(1).max(5).optional(),
          isHighlight: z.boolean(),
        })).describe("Per-scene labels"),
      })
      .describe("The VideoLabels object to save"),
  },
  async ({ labels }) => {
    const data = await sendCommand("save_video_labels", {
      labels,
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
