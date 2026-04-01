import { describe, expect, test, mock, beforeEach } from "bun:test";
import { sampleMediaAssets, sampleVideoLabels, sampleFrames } from "./fixtures";

// Mock sendCommand to simulate WebSocket bridge responses
let mockSendCommand: ReturnType<typeof mock>;

beforeEach(() => {
	mockSendCommand = mock();
});

describe("list_media", () => {
	test("returns serialized media assets from browser", async () => {
		mockSendCommand.mockResolvedValue({ assets: sampleMediaAssets });

		const data = (await mockSendCommand("list_media")) as {
			assets: typeof sampleMediaAssets;
		};

		expect(data.assets).toHaveLength(2);
		expect(data.assets[0].id).toBe("media-001");
		expect(data.assets[0].name).toBe("sample-video.mp4");
		expect(data.assets[0].type).toBe("video");
		expect(data.assets[0].width).toBe(1920);
		expect(data.assets[0].height).toBe(1080);
		expect(data.assets[0].duration).toBe(120);
	});

	test("returns image assets without duration", async () => {
		mockSendCommand.mockResolvedValue({ assets: sampleMediaAssets });

		const data = (await mockSendCommand("list_media")) as {
			assets: typeof sampleMediaAssets;
		};

		const imageAsset = data.assets[1];
		expect(imageAsset.type).toBe("image");
		expect(imageAsset.duration).toBeUndefined();
	});

	test("returns empty array when no media", async () => {
		mockSendCommand.mockResolvedValue({ assets: [] });

		const data = (await mockSendCommand("list_media")) as {
			assets: unknown[];
		};

		expect(data.assets).toHaveLength(0);
	});
});

describe("get_video_frames", () => {
	test("returns frames with time and base64 image", async () => {
		mockSendCommand.mockResolvedValue({
			frames: sampleFrames,
			mediaId: "media-001",
			interval: 5,
		});

		const data = (await mockSendCommand("get_video_frames", {
			mediaId: "media-001",
			interval: 5,
		})) as {
			frames: typeof sampleFrames;
			mediaId: string;
			interval: number;
		};

		expect(data.frames).toHaveLength(3);
		expect(data.frames[0].time).toBe(0);
		expect(data.frames[1].time).toBe(5);
		expect(data.frames[2].time).toBe(10);
		expect(data.mediaId).toBe("media-001");
		expect(data.interval).toBe(5);
	});

	test("each frame has base64 image data", async () => {
		mockSendCommand.mockResolvedValue({
			frames: sampleFrames,
			mediaId: "media-001",
			interval: 5,
		});

		const data = (await mockSendCommand("get_video_frames", {
			mediaId: "media-001",
		})) as {
			frames: Array<{ time: number; image: string }>;
		};

		for (const frame of data.frames) {
			expect(typeof frame.image).toBe("string");
			expect(frame.image.length).toBeGreaterThan(0);
		}
	});

	test("rejects when media not found", async () => {
		mockSendCommand.mockRejectedValue(
			new Error("Media not found: nonexistent"),
		);

		expect(
			mockSendCommand("get_video_frames", { mediaId: "nonexistent" }),
		).rejects.toThrow("Media not found");
	});

	test("rejects when mediaId is missing", async () => {
		mockSendCommand.mockRejectedValue(new Error("mediaId is required"));

		expect(mockSendCommand("get_video_frames", {})).rejects.toThrow(
			"mediaId is required",
		);
	});
});

describe("save_video_labels", () => {
	test("saves labels and returns mediaId", async () => {
		mockSendCommand.mockResolvedValue({ mediaId: "media-001" });

		const data = (await mockSendCommand("save_video_labels", {
			mediaId: "media-001",
			labels: sampleVideoLabels,
		})) as { mediaId: string };

		expect(data.mediaId).toBe("media-001");
	});

	test("rejects when mediaId is missing", async () => {
		mockSendCommand.mockRejectedValue(
			new Error("mediaId and labels are required"),
		);

		expect(
			mockSendCommand("save_video_labels", { labels: sampleVideoLabels }),
		).rejects.toThrow("mediaId and labels are required");
	});

	test("rejects when labels is missing", async () => {
		mockSendCommand.mockRejectedValue(
			new Error("mediaId and labels are required"),
		);

		expect(
			mockSendCommand("save_video_labels", { mediaId: "media-001" }),
		).rejects.toThrow("mediaId and labels are required");
	});
});

describe("get_video_labels", () => {
	test("returns saved labels for a media", async () => {
		mockSendCommand.mockResolvedValue({ labels: sampleVideoLabels });

		const data = (await mockSendCommand("get_video_labels", {
			mediaId: "media-001",
		})) as { labels: typeof sampleVideoLabels };

		expect(data.labels.mediaId).toBe("media-001");
		expect(data.labels.version).toBe(1);
		expect(data.labels.global.summary).toBe("テスト動画の概要");
		expect(data.labels.scenes).toHaveLength(3);
	});

	test("returns null labels when not found", async () => {
		mockSendCommand.mockResolvedValue({ labels: null });

		const data = (await mockSendCommand("get_video_labels", {
			mediaId: "nonexistent",
		})) as { labels: null };

		expect(data.labels).toBeNull();
	});

	test("rejects when mediaId is missing", async () => {
		mockSendCommand.mockRejectedValue(new Error("mediaId is required"));

		expect(mockSendCommand("get_video_labels", {})).rejects.toThrow(
			"mediaId is required",
		);
	});
});

describe("VideoLabels schema", () => {
	test("global metadata has required fields", () => {
		const { global } = sampleVideoLabels;
		expect(global.duration).toBe(120);
		expect(global.resolution).toBe("1920x1080");
		expect(global.fps).toBe(30);
		expect(typeof global.summary).toBe("string");
		expect(typeof global.overallTone).toBe("string");
		expect(Array.isArray(global.speakers)).toBe(true);
	});

	test("scenes have required fields", () => {
		for (const scene of sampleVideoLabels.scenes) {
			expect(typeof scene.startTime).toBe("number");
			expect(typeof scene.endTime).toBe("number");
			expect(scene.endTime).toBeGreaterThan(scene.startTime);
			expect(typeof scene.description).toBe("string");
			expect(["speech", "music", "silence", "noise", "mixed"]).toContain(
				scene.audioType,
			);
			expect(["good", "fair", "poor"]).toContain(scene.visualQuality);
			expect(["static", "pan", "zoom", "handheld"]).toContain(
				scene.cameraMovement,
			);
			expect(scene.energyLevel).toBeGreaterThanOrEqual(1);
			expect(scene.energyLevel).toBeLessThanOrEqual(5);
			expect(typeof scene.isHighlight).toBe("boolean");
		}
	});

	test("scenes cover full duration without gaps", () => {
		const { scenes } = sampleVideoLabels;
		expect(scenes[0].startTime).toBe(0);
		expect(scenes[scenes.length - 1].endTime).toBe(
			sampleVideoLabels.global.duration,
		);

		for (let i = 1; i < scenes.length; i++) {
			expect(scenes[i].startTime).toBe(scenes[i - 1].endTime);
		}
	});

	test("optional fields are handled correctly", () => {
		const sceneWithSpeech = sampleVideoLabels.scenes[0];
		expect(sceneWithSpeech.speechContent).toBeDefined();
		expect(sceneWithSpeech.speaker).toBeDefined();

		const sceneWithoutSpeaker = sampleVideoLabels.scenes[2];
		expect(sceneWithoutSpeaker.speaker).toBeUndefined();
	});
});
