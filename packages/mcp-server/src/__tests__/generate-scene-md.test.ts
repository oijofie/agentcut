import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

function formatTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function generateSceneMd({
	scenes,
	global,
	outputPath,
}: {
	scenes: Array<{
		startTime: number;
		endTime: number;
		description: string;
		category?: string;
		score?: number;
		speechContent?: string;
		speaker?: string;
		isHighlight?: boolean;
	}>;
	global: {
		duration: number;
		resolution: string;
		fps: number;
		summary: string;
		overallTone: string;
		speakers: string[];
	};
	outputPath: string;
}): { outputPath: string; sceneCount: number } {
	const { writeFileSync, mkdirSync } = require("node:fs");

	const outputDir = dirname(outputPath);
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	const lines = [
		`# ${global.summary} — シーン別やりとり詳細`,
		"",
	];

	for (const scene of scenes) {
		const timeRange = `${formatTime(scene.startTime)}〜${formatTime(scene.endTime)}`;
		const title = scene.category || "シーン";
		lines.push(`## ${timeRange} — ${title}`);
		lines.push("");

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

	return { outputPath, sceneCount: scenes.length };
}

const sampleGlobal = {
	duration: 120,
	resolution: "1920x1080",
	fps: 30,
	summary: "テスト動画",
	overallTone: "カジュアル",
	speakers: ["話者A", "話者B"],
};

const sampleScenes = [
	{
		startTime: 0,
		endTime: 30,
		description: "オープニング。話者Aが挨拶している。",
		category: "オープニング",
		score: 3,
		speechContent: "こんにちは、今日はよろしくお願いします",
		speaker: "話者A",
		isHighlight: false,
	},
	{
		startTime: 30,
		endTime: 90,
		description: "メインの対談シーン。白熱した議論が展開される。",
		category: "対談",
		score: 8,
		isHighlight: true,
	},
	{
		startTime: 90,
		endTime: 120,
		description: "エンディング",
		category: "エンディング",
		score: 2,
		isHighlight: false,
	},
];

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "scene-md-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("generate_scene_md", () => {
	test("creates a single MD file", () => {
		const outputPath = join(tmpDir, "scenes.md");
		const result = generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputPath,
		});

		expect(result.sceneCount).toBe(3);
		expect(existsSync(outputPath)).toBe(true);
	});

	test("title uses global summary", () => {
		const outputPath = join(tmpDir, "scenes.md");
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputPath,
		});

		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("# テスト動画 — シーン別やりとり詳細");
	});

	test("each scene has time range and category heading", () => {
		const outputPath = join(tmpDir, "scenes.md");
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputPath,
		});

		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("## 00:00:00〜00:00:30 — オープニング");
		expect(content).toContain("## 00:00:30〜00:01:30 — 対談");
		expect(content).toContain("## 00:01:30〜00:02:00 — エンディング");
	});

	test("descriptions are split into bullet points by sentence", () => {
		const outputPath = join(tmpDir, "scenes.md");
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputPath,
		});

		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("- オープニング。");
		expect(content).toContain("- 話者Aが挨拶している。");
		expect(content).toContain("- メインの対談シーン。");
		expect(content).toContain("- 白熱した議論が展開される。");
	});

	test("speech content is included as quote", () => {
		const outputPath = join(tmpDir, "scenes.md");
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputPath,
		});

		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("- 発言: 「こんにちは、今日はよろしくお願いします」");
	});

	test("scene without speechContent omits speech line", () => {
		const outputPath = join(tmpDir, "scenes.md");
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputPath,
		});

		const content = readFileSync(outputPath, "utf-8");
		const scene2Section = content.split("## 00:00:30〜00:01:30")[1].split("## 00:01:30〜00:02:00")[0];
		expect(scene2Section).not.toContain("発言:");
	});

	test("creates parent directory if needed", () => {
		const outputPath = join(tmpDir, "nested", "dir", "scenes.md");
		expect(existsSync(join(tmpDir, "nested"))).toBe(false);

		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputPath,
		});

		expect(existsSync(outputPath)).toBe(true);
	});
});

describe("formatTime", () => {
	test("formats seconds to HH:MM:SS", () => {
		expect(formatTime(0)).toBe("00:00:00");
		expect(formatTime(30)).toBe("00:00:30");
		expect(formatTime(90)).toBe("00:01:30");
		expect(formatTime(3661)).toBe("01:01:01");
	});
});
