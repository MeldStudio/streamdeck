// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Preloadable scenarios. Each one is a complete Meld session the fake server can
// serve, chosen to exercise a situation that is awkward to stage by hand in the
// real app — an empty session, a project switch where every id changes, a
// vertical-canvas setup, an upgraded profile holding legacy effect ids.

import { type Scenario, SessionBuilder } from "./session.ts";

/** A typical single-project session: three scenes, layers, effects, audio. */
function standard(): Scenario {
	const b = new SessionBuilder("standard");
	const intro = b.scene("Intro", { current: true });
	const main = b.scene("Main", { staged: true });
	const outro = b.scene("Outro");

	const camera = b.layer(intro, "Camera", { source: "camera-0" });
	b.effect(camera, "Brightness Contrast");
	b.effect(camera, "Color Correction", { enabled: false });
	b.layer(intro, "Overlay", { visible: false });

	const media = b.layer(main, "Intro Video", { mediaSource: "intro.mp4", isPlaying: false });
	b.effect(media, "Chroma Key");
	b.layer(main, "Webcam", { source: "camera-1" });
	b.layer(outro, "Credits", { text: "Thanks for watching" });

	b.track("Microphone", { gain: 0.8 });
	b.track("Desktop Audio", { gain: 0.5, muted: true });
	b.track("Game", { gain: 1, monitoring: true });
	return b.build("standard", "Three scenes with layers, effects and three audio tracks");
}

/** The same room after a project switch: same names, all-new ids. */
function reloaded(): Scenario {
	const b = new SessionBuilder("reloaded");
	const live = b.scene("Live", { current: true });
	b.scene("Break");
	const cam = b.layer(live, "Camera", { source: "camera-0" });
	b.effect(cam, "Sharpen");
	b.track("Microphone", { gain: 0.65 });
	b.track("Music", { gain: 0.3 });
	return b.build("reloaded", "A different project: no id from any other scenario appears here");
}

/** A freshly-installed Meld with nothing configured yet. */
function empty(): Scenario {
	const b = new SessionBuilder("empty");
	b.scene("Scene", { current: true });
	return b.build("empty", "One empty scene, no layers, effects or audio tracks");
}

/** Vertical canvas enabled: scenes are duplicated with a [Vertical] variant. */
function vertical(): Scenario {
	const b = new SessionBuilder("vertical");
	const main = b.scene("Main", { current: true });
	b.layer(main, "Camera", { source: "camera-0" });
	const mainV = b.scene("Main", { vertical: true });
	b.layer(mainV, "Camera", { source: "camera-0" });
	b.track("Microphone", { gain: 0.7 });
	return b.build("vertical", "Vertical canvas on: property inspectors must filter the [Vertical] scenes");
}

/** Effects addressed by the historical `<layerId>-<index>` id form. */
function legacyEffectIds(): Scenario {
	const b = new SessionBuilder("legacy-effect-ids");
	const scene = b.scene("Legacy", { current: true });
	const layer = b.layer(scene, "Camera");
	b.effect(layer, "Brightness Contrast", { legacyId: 0 });
	b.effect(layer, "Blur", { legacyId: 1, enabled: false });
	b.track("Microphone", { gain: 0.9 });
	return b.build("legacy-effect-ids", "Effects keyed as <layerId>-<index>, as upgraded profiles store them");
}

/** Live output running, with the replay clip's track present. */
function liveWithReplay(): Scenario {
	const b = new SessionBuilder("live-replay");
	const scene = b.scene("Live", { current: true });
	const clip = b.layer(scene, "Replay Clip", { mediaSource: "replay.mp4", isPlaying: true });
	b.layer(scene, "Camera", { source: "camera-0" });
	b.track("Microphone", { gain: 0.8 });
	// The replay action finds its track by this exact name.
	b.track("Replay Clip", { parent: clip, gain: 0.6 });
	return b.build("live-replay", "Streaming and recording, with a Replay Clip track", {
		streaming: true,
		recording: true,
	});
}

/** A large session, for checking property-inspector lists and render cost. */
function large(): Scenario {
	const b = new SessionBuilder("large");
	for (let s = 0; s < 12; s++) {
		const scene = b.scene(`Scene ${s + 1}`, { current: s === 0 });
		for (let l = 0; l < 6; l++) {
			const layer = b.layer(scene, `Layer ${l + 1}`, { visible: l % 3 !== 0 });
			for (let e = 0; e < 3; e++) {
				b.effect(layer, `Effect ${e + 1}`, { enabled: e % 2 === 0 });
			}
		}
	}
	for (let t = 0; t < 10; t++) {
		b.track(`Track ${t + 1}`, { gain: (t + 1) / 10, muted: t % 4 === 0 });
	}
	return b.build("large", "12 scenes x 6 layers x 3 effects plus 10 tracks");
}

/** Every built-in scenario, keyed by name. */
export const SCENARIOS: Record<string, () => Scenario> = {
	standard,
	reloaded,
	empty,
	vertical,
	"legacy-effect-ids": legacyEffectIds,
	"live-replay": liveWithReplay,
	large,
};

/**
 * Loads a scenario by name.
 * @param name One of {@link SCENARIOS}.
 * @throws When the name is unknown, listing the valid ones.
 */
export function loadScenario(name: string): Scenario {
	const factory = SCENARIOS[name];
	if (!factory) {
		throw new Error(`Unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(", ")}`);
	}
	return factory();
}
