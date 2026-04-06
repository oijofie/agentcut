export interface VideoLabelsData {
	mediaId: string;
	version: number;
	createdAt: string;
	global: {
		duration: number;
		resolution: string;
		fps: number;
		summary: string;
		overallTone: string;
		speakers: string[];
	};
	scenes: Array<{
		startTime: number;
		endTime: number;
		description: string;
		audioType: "speech" | "music" | "silence" | "noise" | "mixed";
		speechContent?: string;
		speaker?: string;
		visualQuality: "good" | "fair" | "poor";
		cameraMovement: "static" | "pan" | "zoom" | "handheld";
		energyLevel: number;
		isHighlight: boolean;
	}>;
}
