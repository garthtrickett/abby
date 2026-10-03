import { VoiceSetupPanel } from "./voice-setup-panel.ts";
import { AutomationSetupPanel } from "./automation-setup-panel.ts";
import { FetchDashboardPort } from "./api.ts";
import { AvailabilitySetupPanel } from "./availability-setup-panel.ts";
import { SpeechGatePanel } from "./speech-gate-panel.ts";
import { OperationalDailyPanel } from "./operational-daily-panel.ts";
import { GreetingSetupPanel } from "./greeting-setup-panel.ts";

const root = document.getElementById("availability-setup");
if (!root) throw new Error("availability setup root missing");
void new AvailabilitySetupPanel(root, new FetchDashboardPort()).load();
const greetingRoot = document.getElementById("greeting-setup");
if (!greetingRoot) throw new Error("greeting setup root missing");
void new GreetingSetupPanel(greetingRoot, new FetchDashboardPort()).load();
const speechRoot = document.getElementById("speech-gate");
if (!speechRoot) throw new Error("speech gate root missing");
void new SpeechGatePanel(speechRoot).load();
const operationalRoot = document.getElementById("operational-daily");
if (!operationalRoot) throw new Error("operational daily root missing");
void new OperationalDailyPanel(operationalRoot).load();

const automationRoot = document.getElementById("automation-setup");
if (!automationRoot) throw new Error("automation setup root missing");
void new AutomationSetupPanel(automationRoot, new FetchDashboardPort()).load();

const voiceRoot = document.getElementById("voice-setup");
if (!voiceRoot) throw new Error("voice setup root missing");
void new VoiceSetupPanel(voiceRoot, new FetchDashboardPort()).load();
