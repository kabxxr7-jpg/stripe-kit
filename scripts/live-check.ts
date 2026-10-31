// Optional: needs STRIPE_SECRET_KEY (a test-mode key). Does nothing without it. See src/live-check.ts.
import { runLiveCheck } from "../src/live-check.ts";

process.exitCode = await runLiveCheck({ env: process.env, log: (line) => console.log(line) });
