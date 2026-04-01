import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function formatTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function generateSceneMd({
	scenes,
	global,
	outputDir,
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
	outputDir: string;
}): { files: string[]; sceneCount: number } {
	const { writeFileSync, mkdirSync } = require("node:fs");

	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	const files: string[] = [];

	for (let i = 0; i < scenes.length; i++) {
		const scene = scenes[i];
		const num = String(i + 1).padStart(2, "0");
		const filename = `scene_${num}.md`;
		const filepath = join(outputDir, filename);

		const lines = [
			`# Scene ${num}: ${scene.category || "No Category"}`,
			"",
			"## Time",
			`- **Start:** ${formatTime(scene.startTime)}`,
			`- **End:** ${formatTime(scene.endTime)}`,
			`- **Duration:** ${Math.round(scene.endTime - scene.startTime)}s`,
			"",
			"## Description",
			scene.description,
			"",
		];

		if (scene.speechContent) {
			lines.push("## Speech Content", scene.speechContent, "");
		}
		if (scene.speaker) {
			lines.push("## Speaker", scene.speaker, "");
		}

		lines.push(
			"## Metadata",
			`- **Score:** ${scene.score ?? "-"}/10`,
			`- **Highlight:** ${scene.isHighlight ? "Yes" : "No"}`,
			"",
		);

		writeFileSync(filepath, lines.join("\n"));
		files.push(filename);
	}

	const indexLines = [
		`# Video Analysis: ${global.summary}`,
		"",
		"## Overview",
		`- **Duration:** ${formatTime(global.duration)}`,
		`- **Resolution:** ${global.resolution}`,
		`- **FPS:** ${global.fps}`,
		`- **Tone:** ${global.overallTone}`,
		`- **Speakers:** ${global.speakers.length ? global.speakers.join(", ") : "N/A"}`,
		"",
		"## Scenes",
		"",
	];

	for (let i = 0; i < scenes.length; i++) {
		const scene = scenes[i];
		const num = String(i + 1).padStart(2, "0");
		const highlight = scene.isHighlight ? " ★" : "";
		indexLines.push(
			`### [Scene ${num}](scene_${num}.md)${highlight}`,
			`- **${formatTime(scene.startTime)} - ${formatTime(scene.endTime)}** | ${scene.category || "-"} | Score: ${scene.score ?? "-"}/10`,
			`- ${scene.description}`,
			"",
		);
	}

	writeFileSync(join(outputDir, "index.md"), indexLines.join("\n"));
	files.push("index.md");

	return { files, sceneCount: scenes.length };
}

const sampleGlobal = {
	duration: 120,
	resolution: "1920x1080",
	fps: 30,
	summary: "テスト動画の概要",
	overallTone: "カジュアル",
	speakers: ["話者A", "話者B"],
};

const sampleScenes = [
	{
		startTime: 0,
		endTime: 30,
		description: "オープニング、話者Aが挨拶している",
		category: "オープニング",
		score: 3,
		speechContent: "こんにちは",
		speaker: "話者A",
		isHighlight: false,
	},
	{
		startTime: 30,
		endTime: 90,
		description: "メインの対談シーン",
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
	test("creates correct number of files", () => {
		const result = generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputDir: tmpDir,
		});

		expect(result.sceneCount).toBe(3);
		expect(result.files).toHaveLength(4); // 3 scenes + index
		expect(result.files).toContain("index.md");
		expect(result.files).toContain("scene_01.md");
		expect(result.files).toContain("scene_02.md");
		expect(result.files).toContain("scene_03.md");
	});

	test("all files exist on disk", () => {
		const result = generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputDir: tmpDir,
		});

		for (const file of result.files) {
			expect(existsSync(join(tmpDir, file))).toBe(true);
		}
	});

	test("scene file contains correct content", () => {
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputDir: tmpDir,
		});

		const scene01 = readFileSync(join(tmpDir, "scene_01.md"), "utf-8");
		expect(scene01).toContain("# Scene 01: オープニング");
		expect(scene01).toContain("**Start:** 00:00:00");
		expect(scene01).toContain("**End:** 00:00:30");
		expect(scene01).toContain("**Duration:** 30s");
		expect(scene01).toContain("オープニング、話者Aが挨拶している");
		expect(scene01).toContain("## Speech Content");
		expect(scene01).toContain("こんにちは");
		expect(scene01).toContain("## Speaker");
		expect(scene01).toContain("話者A");
		expect(scene01).toContain("**Score:** 3/10");
		expect(scene01).toContain("**Highlight:** No");
	});

	test("highlight scene is marked correctly", () => {
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputDir: tmpDir,
		});

		const scene02 = readFileSync(join(tmpDir, "scene_02.md"), "utf-8");
		expect(scene02).toContain("**Highlight:** Yes");
		expect(scene02).toContain("**Score:** 8/10");
	});

	test("scene without optional fields omits those sections", () => {
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputDir: tmpDir,
		});

		const scene02 = readFileSync(join(tmpDir, "scene_02.md"), "utf-8");
		expect(scene02).not.toContain("## Speech Content");
		expect(scene02).not.toContain("## Speaker");
	});

	test("index file contains overview and scene list", () => {
		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputDir: tmpDir,
		});

		const index = readFileSync(join(tmpDir, "index.md"), "utf-8");
		expect(index).toContain("# Video Analysis: テスト動画の概要");
		expect(index).toContain("**Duration:** 00:02:00");
		expect(index).toContain("**Resolution:** 1920x1080");
		expect(index).toContain("**Tone:** カジュアル");
		expect(index).toContain("**Speakers:** 話者A, 話者B");
		expect(index).toContain("[Scene 01](scene_01.md)");
		expect(index).toContain("[Scene 02](scene_02.md) ★");
		expect(index).toContain("[Scene 03](scene_03.md)");
	});

	test("creates output directory if it does not exist", () => {
		const nestedDir = join(tmpDir, "nested", "output");
		expect(existsSync(nestedDir)).toBe(false);

		generateSceneMd({
			scenes: sampleScenes,
			global: sampleGlobal,
			outputDir: nestedDir,
		});

		expect(existsSync(nestedDir)).toBe(true);
		expect(existsSync(join(nestedDir, "index.md"))).toBe(true);
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
