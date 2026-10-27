/*
 * Vision support is a heuristic because model ids are not standardized.
 * "auto" is optimistic only for families known to accept images; a user can
 * force it on or off in Settings.
 */

const VISION = /(vision|-vl\b|\bvl-|llava|gemma-?[34]|qwen[\d.]*-?vl|internvl|minicpm-v|pixtral|gpt-4o|gpt-4\.1|gpt-5|o[34]-|claude|gemini|grok.*vision|mistral-small-3|llama-?3\.2|llama-?4|glm-4\.[\dv]+|nemotron.*vl)/i;

const TEXT_ONLY = /(coder|embed|whisper|tts|rerank|guard)/i;

export function supportsVision(model, setting = "auto") {
  if (setting === "on") return true;
  if (setting === "off") return false;
  const id = String(model || "");
  if (!id) return false;
  if (TEXT_ONLY.test(id)) return false;
  return VISION.test(id);
}
