export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function decodeEntitiesOnce(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;|&#32;|&#160;/g, " ");
}

export function stripHtmlToText(raw: string): string {
  const withoutBlocks = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  let decoded = withoutBlocks;
  for (let i = 0; i < 5; i += 1) {
    const next = decodeEntitiesOnce(decoded);
    if (next === decoded) {
      break;
    }
    decoded = next;
  }

  const withoutTags = decoded
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  return collapseWhitespace(withoutTags);
}