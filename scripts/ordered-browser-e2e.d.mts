export type BrowserCase = Readonly<{ file: string; line: number; title: string }>;
export type BrowserSchedulingEvent = Readonly<{
  kind: "started" | "finished";
  test: BrowserCase;
  activeTests: number;
}>;
export function runOrderedBrowserE2E(files: readonly string[], options: Readonly<{
  pattern: string;
  workers?: number;
  onEvent?: (event: BrowserSchedulingEvent) => void;
}>): Promise<Readonly<{
  passed: number;
  startOrder: readonly BrowserCase[];
  peakActiveTests: number;
}>>;
