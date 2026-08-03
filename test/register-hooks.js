// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Lets the tests import `src/` directly. Source files use the ESM-correct `.js`
// specifiers that the bundler expects, but only the `.ts` files exist on disk,
// so Node's type stripping cannot resolve them. This maps a relative `.js`
// specifier to its `.ts` sibling when that is what is actually there.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL && specifier.endsWith(".js") && /^\.\.?\//.test(specifier)) {
			const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
			if (existsSync(fileURLToPath(candidate))) {
				return { url: candidate.href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	},
});
