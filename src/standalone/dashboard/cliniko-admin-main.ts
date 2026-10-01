import { FetchDashboardPort } from "./api.ts";
import { AvailabilitySetupPanel } from "./availability-setup-panel.ts";
import { SpeechGatePanel } from "./speech-gate-panel.ts";

const root = document.getElementById("availability-setup");
if (!root) throw new Error("availability setup root missing");
void new AvailabilitySetupPanel(root, new FetchDashboardPort()).load();
const speechRoot = document.getElementById("speech-gate");
if (!speechRoot) throw new Error("speech gate root missing");
void new SpeechGatePanel(speechRoot).load();
