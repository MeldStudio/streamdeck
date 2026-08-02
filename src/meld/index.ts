// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { MeldConnection } from "./connection.js";

export { MeldConnection } from "./connection.js";
export { MeldSession } from "./session.js";
export type { GainChange, MeldEventMap } from "./events.js";
export type * from "./types.js";

/**
 * The single, process-wide Meld Studio connection shared by every action and by
 * the property-inspector bridge. Import this rather than opening new sockets.
 */
export const meld = new MeldConnection();
