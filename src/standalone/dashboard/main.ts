import { FetchDashboardPort } from "./api.ts";
import { DashboardController } from "./controller.ts";
import { AvailabilitySetupPanel } from "./availability-setup-panel.ts";

const root = document.getElementById("app");
if (!root) throw new Error("dashboard root missing");
const setupRoot = document.getElementById("availability-setup");
if (!setupRoot) throw new Error("availability setup root missing");
const port = new FetchDashboardPort();
void new DashboardController(root, port).load();
void new AvailabilitySetupPanel(setupRoot, port).load();
