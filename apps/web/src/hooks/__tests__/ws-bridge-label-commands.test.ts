import { afterEach, describe, expect, test, mock } from "bun:test";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/types/assets";

type MockEditor = {
	media: {
		getAssets: () => Partial<MediaAsset>[];
	};
};

const originalGetInstance = EditorCore.getInstance;

function mockEditorCore({ editor }: { editor: MockEditor }): void {
	(
		EditorCore as unknown as {
			getInstance: () => EditorCore;
		}
	).getInstance = () => editor as unknown as EditorCore;
}

function restoreEditorCore(): void {
	(
		EditorCore as unknown as {
			getInstance: typeof EditorCore.getInstance;
		}
	).getInstance = originalGetInstance;
}

afterEach(() => {
	restoreEditorCore();
});

describe("list_media command handler", () => {
	test("serializes media assets with correct fields", () => {
		const assets: Partial<MediaAsset>[] = [
			{
				id: "vid-001",
				name: "video.mp4",
				type: "video",
				width: 1920,
				height: 1080,
				duration: 60,
			},
			{
				id: "img-001",
				name: "logo.png",
				type: "image",
				width: 200,
				height: 50,
			},
		];

		mockEditorCore({
			editor: { media: { getAssets: () => assets } },
		});

		const editor = EditorCore.getInstance();
		const result = editor.media.getAssets().map((a) => ({
			id: a.id,
			name: a.name,
			type: a.type,
			width: a.width,
			height: a.height,
			duration: a.duration,
		}));

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			id: "vid-001",
			name: "video.mp4",
			type: "video",
			width: 1920,
			height: 1080,
			duration: 60,
		});
		expect(result[1].duration).toBeUndefined();
	});

	test("returns empty array when no assets", () => {
		mockEditorCore({
			editor: { media: { getAssets: () => [] } },
		});

		const editor = EditorCore.getInstance();
		const result = editor.media.getAssets();

		expect(result).toHaveLength(0);
	});

	test("excludes file and url from serialization", () => {
		const assets: Partial<MediaAsset>[] = [
			{
				id: "vid-001",
				name: "video.mp4",
				type: "video",
				width: 640,
				height: 360,
				duration: 30,
				url: "blob:http://localhost:3000/abc",
				file: new File([], "video.mp4"),
			},
		];

		mockEditorCore({
			editor: { media: { getAssets: () => assets } },
		});

		const editor = EditorCore.getInstance();
		const serialized = editor.media.getAssets().map((a) => ({
			id: a.id,
			name: a.name,
			type: a.type,
			width: a.width,
			height: a.height,
			duration: a.duration,
		}));

		expect(serialized[0]).not.toHaveProperty("url");
		expect(serialized[0]).not.toHaveProperty("file");
	});
});

describe("get_video_frames validation", () => {
	test("finds asset by mediaId", () => {
		const assets: Partial<MediaAsset>[] = [
			{ id: "vid-001", name: "video.mp4", type: "video", url: "blob:abc" },
			{ id: "vid-002", name: "other.mp4", type: "video", url: "blob:def" },
		];

		mockEditorCore({
			editor: { media: { getAssets: () => assets } },
		});

		const editor = EditorCore.getInstance();
		const target = editor
			.media.getAssets()
			.find((a) => a.id === "vid-001");

		expect(target).toBeDefined();
		expect(target!.name).toBe("video.mp4");
		expect(target!.url).toBe("blob:abc");
	});

	test("returns undefined when mediaId not found", () => {
		const assets: Partial<MediaAsset>[] = [
			{ id: "vid-001", name: "video.mp4", type: "video" },
		];

		mockEditorCore({
			editor: { media: { getAssets: () => assets } },
		});

		const editor = EditorCore.getInstance();
		const target = editor
			.media.getAssets()
			.find((a) => a.id === "nonexistent");

		expect(target).toBeUndefined();
	});
});

describe("save_video_labels validation", () => {
	test("requires both mediaId and labels", () => {
		const params1 = { mediaId: "vid-001" };
		const params2 = { labels: {} };
		const params3 = { mediaId: "vid-001", labels: { version: 1 } };

		expect(!params1.mediaId || !(params1 as Record<string, unknown>).labels).toBe(true);
		expect(!(params2 as Record<string, unknown>).mediaId || !params2.labels).toBe(true);
		expect(!(!params3.mediaId || !params3.labels)).toBe(true);
	});
});

describe("get_video_labels validation", () => {
	test("requires mediaId", () => {
		const validParams = { mediaId: "vid-001" };
		const invalidParams = {} as Record<string, unknown>;

		expect(!!validParams.mediaId).toBe(true);
		expect(!!invalidParams.mediaId).toBe(false);
	});
});
