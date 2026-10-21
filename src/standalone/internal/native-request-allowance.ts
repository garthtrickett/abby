/** Ephemeral cumulative allowance across several native owners in ONE request.
 * It never replaces their shared physical API-user budget or grants authority. */
export class NativeRequestAllowance {
  readonly #maximum: number;
  #used = 0;
  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 180) throw Error("Invalid native request allowance");
    this.#maximum = maximum;
  }
  hasHeadroom(count: number): boolean {
    return Number.isSafeInteger(count) && count >= 0 && count <= this.#maximum - this.#used;
  }
  take(): boolean {
    if (!this.hasHeadroom(1)) return false;
    this.#used++; return true;
  }
}
