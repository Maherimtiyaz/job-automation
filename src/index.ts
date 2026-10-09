import { loadConfig } from "./config.js";

function main(): void {
  const config = loadConfig();
  console.log(`[job-automation] started (NODE_ENV=${config.NODE_ENV})`);
  console.log(`[job-automation] database: ${config.DATABASE_PATH}`);
}

main();
