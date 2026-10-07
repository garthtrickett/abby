/** This recognizes complete announcements, not the identity of an audio speaker.
 * Its bounded memory lives only in the call and never includes private prompts. */
function normalized(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim();
}

function repeatedHold(text: string): boolean {
  let remaining = text;
  while (remaining) {
    // Each match consumes at least two complete words. An optional "please wait"
    // is its own phrase, avoiding ambiguous repeated-regex backtracking.
    const phrase = /^(?:you (?:have been|are) (?:placed )?on hold|please (?:hold|wait)(?: on the line)?)(?: |$)/.exec(remaining);
    if (!phrase) return false;
    remaining = remaining.slice(phrase[0].length);
  }
  return true;
}

function announcement(text: string): boolean {
  return !!text && repeatedHold(text) ||
    /^(?:to (?:authori[sz]e|allow|cancel) (?:this|these|the) transactions?|(?:you have received|next delivery system from)\b|(?:there is|this is|it's) (?:an? )?(?:un)?authori[sz]ed transaction\b)/.test(text) &&
    /\bpress (?:1|one)\b/.test(text) && /\b(?:press (?:2|two)|or (?:press )?(?:2|two))\b/.test(text) &&
    /\b(?:transaction|transactions|bank security|sms|listen to the message)\b/.test(text);
}

export class UnattendedTurnGuard {
  private readonly recentOutput: string[] = [];
  private announcements = 0;

  clear(): void { this.recentOutput.length = 0; this.announcements = 0; }

  rememberOutput(text: string): void {
    const value = normalized(text);
    // Short shared words such as "yes" cannot identify echoed clinic speech.
    if (value.length < 24) return;
    if (!this.recentOutput.includes(value)) this.recentOutput.push(value);
    if (this.recentOutput.length > 3) this.recentOutput.shift();
  }

  accept(text: string): "notice" | "close" | undefined {
    const value = normalized(text);
    if (!announcement(value) && !this.recentOutput.includes(value)) return undefined;
    // Cumulative within this call: intervening announcements cannot reset the bound.
    return ++this.announcements >= 3 ? "close" : "notice";
  }
}
