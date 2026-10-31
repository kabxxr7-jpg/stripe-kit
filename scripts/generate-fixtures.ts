// Writes the fixture event files (unsigned JSON, exactly as the signer will sign them).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureFiles, serializeEvent } from "../testing/fixtures.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
for (const f of fixtureFiles()) {
  const target = join(root, f.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeEvent(f.event) + "\n");
  console.log(`wrote fixtures/${f.path}`);
}
