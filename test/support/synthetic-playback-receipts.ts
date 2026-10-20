/** Test caller's outstanding transport marks; no SAM authority is constructed. */
export class SyntheticPlaybackReceipts {
  readonly #marks: string[] = [];
  readonly #acknowledged = new Set<string>();
  readonly #cleared = new Set<string>();
  readonly #send: (name: string) => void;
  constructor(send: (name: string) => void) { this.#send = send; }
  get count(): number { return this.#marks.length; }
  hasPendingAfter(count = 0): boolean {
    return this.#marks.slice(count).some(name => !this.#acknowledged.has(name));
  }
  /** A played reply remains observable after its receipt was consumed. Marks
   * returned only by a clear never count as that response. */
  hasReplyAfter(count = 0): boolean {
    return this.#marks.slice(count).some(name => !this.#cleared.has(name));
  }
  receive(event: Readonly<{ event: string; mark?: { name: string } }>): void {
    if (event.event === "mark" && event.mark) this.#marks.push(event.mark.name);
    if (event.event === "clear") {
      // The transport's completion marks and final clear fence are returned in
      // order. The stream distinguishes these from played speech itself.
      for (const name of this.#marks) {
        if (this.#acknowledged.has(name)) continue;
        this.#cleared.add(name);
        this.#acknowledged.add(name); this.#send(name);
      }
    }
  }
  acknowledgeLatest(): boolean {
    const name = this.#marks.filter(value => !this.#acknowledged.has(value)).at(-1);
    if (name === undefined) return false;
    this.#acknowledged.add(name); this.#send(name); return true;
  }
}
