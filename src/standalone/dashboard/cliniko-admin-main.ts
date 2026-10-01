import { FetchDashboardPort } from "./api.ts";
import { AvailabilitySetupPanel } from "./availability-setup-panel.ts";

const root = document.getElementById("availability-setup");
if (!root) throw new Error("availability setup root missing");
void new AvailabilitySetupPanel(root, new FetchDashboardPort()).load();
