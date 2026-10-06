/** A delivery question selects a read of current receipts; it never grants a send. */
export function notificationQuestion(text: string): boolean {
  const value = text.toLowerCase().replace(/[’]/g, "'");
  if (/\b(?:do not|don't|never|no need to)\b/.test(value)) return false;
  return /\b(?:email|e-mail)\b/.test(value) && /\b(?:proof|confirmation|confirm|booking|appointment)\b/.test(value) ||
    /\b(?:delivery status|confirmation (?:was |has been )?(?:sent|received|delivered))\b/.test(value);
}
