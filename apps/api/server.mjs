// Arcunara Studio API — application entry point (v0.3.0).
//
// Behavior baseline: legacy-v02/server.mjs (validated on the VPS), migrated
// to apps/api with environment-driven configuration and modular structure.

import http from "node:http";
import { loadConfig } from "./lib/config.mjs";
import { createAuth } from "./lib/auth.mjs";
import { createStore } from "./lib/store.mjs";
import { createApiHandler } from "./lib/routes.mjs";
import { createPreviewHandler } from "./lib/preview.mjs";
import { createPreviewTickets } from "./lib/preview-tickets.mjs";
import { createSiteHandler } from "./lib/sites.mjs";

const VERSION = "0.3.0";

function fail(message) {
  console.error(message);
  process.exit(1);
}

let config;

try {
  config = loadConfig(process.env);
} catch (err) {
  fail(err.message);
}

const auth = createAuth(config.token);
const store = createStore(config);
await store.init();
const previewTickets = createPreviewTickets();

const api = http.createServer(
  createApiHandler({ config, store, auth, previewTickets, version: VERSION, getPreviewPort: () => getPreviewPort() })
);

const preview = http.createServer(createPreviewHandler({ store, config, previewTickets }));

// RC13 is deliberately opt-in: a THIRD listener, never a route on the API
// or preview origin. The container's original ports remain unchanged.
const staticSites = config.siteHostingEnabled
  ? http.createServer(createSiteHandler({ store, config }))
  : null;

api.listen(config.apiPort, config.apiHost, () => {
  console.log(`Arcunara API v0.3 started on port ${api.address().port}`);
});

preview.listen(config.previewPort, config.previewHost, () => {
  console.log(
    `Arcunara Preview v0.3 started on port ${preview.address().port}`
  );
});

if (staticSites) {
  staticSites.listen(config.sitePort, config.siteHost, () => {
    console.log(`Arcunara Sites v0.3 started on port ${staticSites.address().port}`);
  });
}

// The workbench builds preview links from the ACTUAL bound preview port
// (config may say 0 = ephemeral) unless a public base URL is configured.
const getPreviewPort = () =>
  preview.listening ? preview.address().port : config.previewPort;
