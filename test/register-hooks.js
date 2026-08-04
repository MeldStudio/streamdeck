// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Lets the tests import TypeScript source directly.
//
// Two hooks are needed. `resolve` maps the ESM-correct `.js` specifiers the
// source uses (and the bundler expects) onto the `.ts` files that actually
// exist on disk. `load` compiles those files with TypeScript rather than
// leaning on Node's type stripping, which cannot parse the standard decorators
// the Stream Deck SDK uses to declare actions.

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/** Matches this project's tsconfig; type checking is `npm run typecheck`'s job. */
const COMPILER_OPTIONS = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	useDefineForClassFields: true,
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL && specifier.endsWith(".js") && /^\.\.?\//.test(specifier)) {
			const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
			try {
				readFileSync(fileURLToPath(candidate));
				return { url: candidate.href, shortCircuit: true };
			} catch {
				// No `.ts` sibling; fall through to the default resolution.
			}
		}
		return nextResolve(specifier, context);
	},

	load(url, context, nextLoad) {
		if (url.startsWith("file:") && url.endsWith(".ts")) {
			const fileName = fileURLToPath(url);
			const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
				fileName,
				compilerOptions: COMPILER_OPTIONS,
			});
			return { format: "module", source: outputText, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});
