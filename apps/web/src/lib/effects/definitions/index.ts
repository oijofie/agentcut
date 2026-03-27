import { hasEffect, registerEffect } from "../registry";
import { blurEffectDefinition } from "./blur";
import { letterboxEffectDefinition } from "./letterbox";

const defaultEffects = [blurEffectDefinition, letterboxEffectDefinition];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (hasEffect({ effectType: definition.type })) {
			continue;
		}
		registerEffect({ definition });
	}
}
