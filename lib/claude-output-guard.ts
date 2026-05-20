function stripTagsPreview(text: string, maxLen: number) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function looksLikeHtmlErrorPayload(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (/^<!doctype html/i.test(t)) return true;
  if (/^<html[\s>]/i.test(t)) return true;
  if (/<head[\s>]/i.test(t) && /<body[\s>]/i.test(t)) return true;
  if (/<(title|h1)[^>]*>\s*(4\d{2}|5\d{2})/i.test(t)) return true;
  return false;
}

export function coerceClaudeErrorMessage(rawText: string) {
  const preview = stripTagsPreview(rawText, 160);
  const hint = preview ? ` (${preview})` : "";
  return `AI service returned an unexpected response. Please try again.${hint}`;
}

/**
 * Guard against the rare case where text reaches us as an HTML error page
 * (e.g. a gateway 5xx surfaced as a body string instead of a thrown SDK error).
 */
export function assertClaudeTextOk(text: string) {
  if (looksLikeHtmlErrorPayload(text)) {
    throw new Error(coerceClaudeErrorMessage(text));
  }
}
