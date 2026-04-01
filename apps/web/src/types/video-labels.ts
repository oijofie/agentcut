export interface VideoScene {
	startTime: number;
	endTime: number;
	description: string;
	category: string;
	score: number;
	speechContent?: string;
	speaker?: string;
	isHighlight: boolean;
}

export interface VideoLabels {
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
	scenes: VideoScene[];
}
