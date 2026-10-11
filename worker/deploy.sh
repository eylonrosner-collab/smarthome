#!/usr/bin/env bash
# Create the KV namespace, store Worker secrets, and deploy.
# Nothing in this script prints secret values.
#
# Required environment:
#   CLOUDFLARE_API_TOKEN   Workers Scripts Edit + Workers KV Storage Edit
#   CLOUDFLARE_ACCOUNT_ID
#   TUYA_ACCESS_ID
#   TUYA_ACCESS_SECRET
#   HYDRAWISE_API_KEY
#   DASH_PASSWORD
#
# Optional:
#   ./deploy.sh --write-config
#     writes the deployed https://….workers.dev URL into ../docs/config.js
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${TUYA_ACCESS_ID:?Set TUYA_ACCESS_ID}"
: "${TUYA_ACCESS_SECRET:?Set TUYA_ACCESS_SECRET}"
: "${HYDRAWISE_API_KEY:?Set HYDRAWISE_API_KEY}"
: "${DASH_PASSWORD:?Set DASH_PASSWORD}"

WRITE_CONFIG=0
for arg in "$@"; do
  if [[ "$arg" == "--write-config" ]]; then WRITE_CONFIG=1; fi
done

if [[ ! -d node_modules/wrangler ]]; then
  npm install
fi

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

node --input-type=module <<'NODE'
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const tomlPath = "wrangler.toml";
const toml = readFileSync(tomlPath, "utf8");
const name = toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
if (!name) throw new Error("wrangler.toml is missing name");
const title = `${name}-RULES`;

function wrangler(args) {
  return execSync(`npx wrangler ${args}`, { encoding: "utf8" });
}

const listRaw = wrangler("kv namespace list");
const listStart = listRaw.indexOf("[");
const list = listStart >= 0 ? JSON.parse(listRaw.slice(listStart)) : [];
let id = list.find((ns) => ns.title === title)?.id;
if (!id) {
  const created = wrangler("kv namespace create RULES");
  id = created.match(/[0-9a-f]{32}/i)?.[0];
  if (!id) {
    console.error(created);
    throw new Error("Could not read the new KV namespace id");
  }
  console.log("Created KV namespace", title);
} else {
  console.log("Using KV namespace", title);
}
const next = toml.replace(/id\s*=\s*"[0-9a-f]{32}"/i, `id = "${id}"`);
if (next !== toml) writeFileSync(tomlPath, next);
console.log("KV id", id);
NODE

put_secret() {
  # wrangler reads the secret from stdin. printf does not add a newline.
  printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null
  echo "Secret set: $1"
}

put_secret TUYA_ACCESS_ID "$TUYA_ACCESS_ID"
put_secret TUYA_ACCESS_SECRET "$TUYA_ACCESS_SECRET"
put_secret HYDRAWISE_API_KEY "$HYDRAWISE_API_KEY"
put_secret DASH_PASSWORD "$DASH_PASSWORD"

DEPLOY_OUT="$(npx wrangler deploy)"
printf '%s\n' "$DEPLOY_OUT"
URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n 1 || true)"
if [[ -z "$URL" ]]; then
  echo "Deploy finished, but the workers.dev URL was not in the output. Copy it from the Cloudflare dashboard." >&2
  exit 0
fi
echo "Worker URL: $URL"

if [[ "$WRITE_CONFIG" == 1 ]]; then
  WORKER_PUBLIC_URL="$URL" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = "../docs/config.js";
const url = process.env.WORKER_PUBLIC_URL;
const text = readFileSync(path, "utf8");
const next = text.replace(/export const WORKER_URL = ".*";/, `export const WORKER_URL = "${url}";`);
if (next === text) throw new Error("docs/config.js has no WORKER_URL assignment to replace");
writeFileSync(path, next);
console.log("Updated docs/config.js");
NODE
  echo "Commit and push docs/config.js so GitHub Pages calls this Worker. The file contains only the URL."
else
  echo "To point the site at this Worker, run again with --write-config or set WORKER_URL in docs/config.js to:"
  echo "  $URL"
fi
