// Grok's xAI first-party rate entry has no bare alias.
export function cursorRateModel(model: string): string {
  const base = model
    .replace(/^cursor-/, "")
    .replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  return base.startsWith("grok-") ? `xai/${base}` : base;
}
