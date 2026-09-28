import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  workers: 2,
  reporter: "list",
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure" },
});
