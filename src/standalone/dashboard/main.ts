import { FetchDashboardPort } from "./api.ts";
import { DashboardController } from "./controller.ts";

const root = document.getElementById("app");
if (!root) throw new Error("dashboard root missing");
void new DashboardController(root, new FetchDashboardPort()).load();
