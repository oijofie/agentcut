import type { VideoLabelsData } from "../types";

export const sampleMediaAssets = [
	{
		id: "media-001",
		name: "sample-video.mp4",
		type: "video" as const,
		width: 1920,
		height: 1080,
		duration: 120,
	},
	{
		id: "media-002",
		name: "logo.png",
		type: "image" as const,
		width: 300,
		height: 100,
	},
];

export const sampleVideoLabels: VideoLabelsData = {
	mediaId: "media-001",
	version: 1,
	createdAt: "2026-04-01T00:00:00.000Z",
	global: {
		duration: 120,
		resolution: "1920x1080",
		fps: 30,
		summary: "テスト動画の概要",
		overallTone: "カジュアル",
		speakers: ["話者A", "話者B"],
	},
	scenes: [
		{
			startTime: 0,
			endTime: 30,
			description: "オープニング、話者Aが挨拶している",
			audioType: "speech",
			speechContent: "こんにちは、今日は特別なゲストをお迎えしています",
			speaker: "話者A",
			visualQuality: "good",
			cameraMovement: "static",
			energyLevel: 3,
			isHighlight: false,
		},
		{
			startTime: 30,
			endTime: 90,
			description: "メインの対談シーン",
			audioType: "speech",
			speechContent: "それでは本題に入りましょう",
			speaker: "話者A",
			visualQuality: "good",
			cameraMovement: "pan",
			energyLevel: 4,
			isHighlight: true,
		},
		{
			startTime: 90,
			endTime: 120,
			description: "エンディング、まとめ",
			audioType: "mixed",
			visualQuality: "good",
			cameraMovement: "static",
			energyLevel: 2,
			isHighlight: false,
		},
	],
};

export const sampleFrames = [
	{ time: 0, image: "base64data0" },
	{ time: 5, image: "base64data5" },
	{ time: 10, image: "base64data10" },
];
