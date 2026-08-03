// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Runs a fake Meld Studio for the Stream Deck plugin to talk to.
//
// Start it with Meld closed and the real plugin connects to it as if it were
// Meld, letting you preload a session, switch projects, drop the connection, or
// flip streaming/recording from the keyboard — states that are slow or awkward
// to reproduce in the real app.
//
//   npm run fake-meld -- --scenario standard
//   npm run fake-meld -- --list

import { stdin, stdout } from "node:process";

import { loadScenario, SCENARIOS } from "./scenarios.ts";
import { FakeMeld } from "./server.ts";
import type { FakeTrack, Scenario } from "./session.ts";

/** The port Meld Studio's WebChannel server listens on. */
const MELD_PORT = 13376;

/** Parsed command line. */
type Args = {
	scenario: string;
	port: number;
	list: boolean;
	quiet: boolean;
	broken?: "stall" | "no-meld" | "no-observers";
};

/** Parses `process.argv`, falling back to sensible defaults. */
function parseArgs(argv: string[]): Args {
	const args: Args = { scenario: "standard", port: MELD_PORT, list: false, quiet: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--list" || arg === "-l") {
			args.list = true;
		} else if (arg === "--quiet" || arg === "-q") {
			args.quiet = true;
		} else if (arg === "--scenario" || arg === "-s") {
			args.scenario = argv[++i];
		} else if (arg === "--port" || arg === "-p") {
			args.port = Number(argv[++i]);
		} else if (arg === "--broken") {
			args.broken = argv[++i] as Args["broken"];
		}
	}
	return args;
}

/** Prints the available scenarios with their descriptions. */
function listScenarios(): void {
	stdout.write("\nScenarios:\n");
	for (const name of Object.keys(SCENARIOS)) {
		stdout.write(`  ${name.padEnd(18)} ${loadScenario(name).description}\n`);
	}
	stdout.write("\n");
}

/** One-line summary of what a scenario contains. */
function describe(scenario: Scenario): string {
	const items = Object.values(scenario.session.items);
	const count = (type: string): number => items.filter((i) => i.type === type).length;
	return `${count("scene")} scenes, ${count("layer")} layers, ${count("effect")} effects, ${count("track")} tracks`;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
	listScenarios();
	process.exit(0);
}

let scenario: Scenario;
try {
	scenario = loadScenario(args.scenario);
} catch (err) {
	stdout.write(`${(err as Error).message}\n`);
	process.exit(1);
}

const server = new FakeMeld(scenario, {
	omitMeldObject: args.broken === "no-meld",
	stallHandshake: args.broken === "stall",
	omitObserverApi: args.broken === "no-observers",
	onInvoke: args.quiet
		? undefined
		: ({ method, args: callArgs }) => {
				stdout.write(`  → ${method}(${callArgs.map((a) => JSON.stringify(a)).join(", ")})\n`);
			},
});

const port = await server.listen(args.port);
stdout.write(`\nFake Meld Studio listening on ws://127.0.0.1:${port}\n`);
stdout.write(`Scenario: ${scenario.name} — ${describe(scenario)}\n`);
if (args.broken) {
	stdout.write(`Fault injected: ${args.broken}\n`);
}
if (port === MELD_PORT) {
	stdout.write("Close Meld Studio first, or the plugin will connect to the real app instead.\n");
}

const KEYS = `
  1-7  load scenario by number      s  toggle streaming
  r    toggle recording             d  drop all clients (simulates a crash)
  n    next scene                   g  nudge every track's gain
  l    list scenarios               ?  show this help
  q    quit
`;
stdout.write(`${KEYS}\n`);

const names = Object.keys(SCENARIOS);
let streaming = scenario.isStreaming;
let recording = scenario.isRecording;

/** Applies a keypress to the running server. */
async function handleKey(key: string): Promise<void> {
	const index = Number(key) - 1;
	if (Number.isInteger(index) && index >= 0 && index < names.length) {
		const next = loadScenario(names[index]);
		server.loadScenario(next);
		streaming = next.isStreaming;
		recording = next.isRecording;
		stdout.write(`\nLoaded "${next.name}" — ${describe(next)}\n`);
		return;
	}

	switch (key) {
		case "s":
			streaming = !streaming;
			server.setStreaming(streaming);
			stdout.write(`\nStreaming: ${streaming}\n`);
			return;
		case "r":
			recording = !recording;
			server.setRecording(recording);
			stdout.write(`\nRecording: ${recording}\n`);
			return;
		case "d":
			stdout.write("\nDropping clients; the plugin should reconnect on its own.\n");
			await server.close();
			await server.listen(port);
			return;
		case "n": {
			const scenes = Object.entries(server.session.items).filter(([, item]) => item.type === "scene");
			if (scenes.length === 0) {
				return;
			}
			const currentAt = scenes.findIndex(([, item]) => item.type === "scene" && item.current);
			const [nextId, next] = scenes[(currentAt + 1) % scenes.length];
			server.showScene(nextId);
			stdout.write(`\nCurrent scene: ${next.type === "scene" ? next.name : nextId}\n`);
			return;
		}
		case "g": {
			for (const [id, item] of Object.entries(server.session.items)) {
				if (item.type !== "track") {
					continue;
				}
				const current = server.gainOf(id) ?? 0;
				// Walk gain around so observers see a stream of updates.
				server.setGain(id, current >= 0.95 ? 0.1 : current + 0.1);
			}
			stdout.write("\nNudged every track's gain.\n");
			return;
		}
		case "l":
			listScenarios();
			names.forEach((name, i) => stdout.write(`  ${i + 1}: ${name}\n`));
			return;
		case "?":
			stdout.write(KEYS);
			return;
		case "q":
		case "":
			stdout.write("\nStopping.\n");
			await server.close();
			process.exit(0);
	}
}

if (stdin.isTTY) {
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	stdin.on("data", (key) => void handleKey(String(key)));
	names.forEach((name, i) => stdout.write(`  ${i + 1}: ${name}\n`));
	stdout.write("\n");
} else {
	stdout.write("(not a TTY: running without keyboard control)\n");
}

/** Reports a track's state, useful when watching the log. */
export function trackSummary(track: FakeTrack): string {
	return `${track.name}${track.muted ? " [muted]" : ""}${track.monitoring ? " [cue]" : ""}`;
}
