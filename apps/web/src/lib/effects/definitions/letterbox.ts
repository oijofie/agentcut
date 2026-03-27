import type { EffectDefinition } from "@/types/effects";
import letterboxFragmentShader from "./letterbox.frag.glsl";

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [
		Number.parseInt(h.substring(0, 2), 16) / 255,
		Number.parseInt(h.substring(2, 4), 16) / 255,
		Number.parseInt(h.substring(4, 6), 16) / 255,
	];
}

export const letterboxEffectDefinition: EffectDefinition = {
	type: "letterbox",
	name: "Letterbox",
	keywords: ["letterbox", "cinematic", "black bars", "crop", "widescreen"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 12,
			min: 0,
			max: 50,
			step: 1,
		},
		{
			key: "color",
			label: "Color",
			type: "color",
			default: "#000000",
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: letterboxFragmentShader,
				uniforms: ({ effectParams }) => {
					const amount =
						typeof effectParams.amount === "number"
							? effectParams.amount
							: Number.parseFloat(
									String(effectParams.amount),
								);
					const color =
						typeof effectParams.color === "string"
							? effectParams.color
							: "#000000";
					return {
						u_amount: amount,
						u_color: hexToRgb(color),
					};
				},
			},
		],
	},
};
