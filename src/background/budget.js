// Turn a model's real context window into character budgets for one step.
//
// The model sees: system prompt + tool schemas + history + (maybe) an image,
// and must still have room to answer. The old budget counted only the system
// prompt and history in characters, so a local model with a 4k-8k window was
// handed ~24k tokens and the server silently cut the front of the prompt (the
// system prompt and tool rules went first). When the window is unknown (cloud
// models, servers that do not report it) the character setting still governs,
// exactly as before.

// Mixed English, Markdown, JSON and URLs tokenize at roughly 3-4 characters per
// token. Use the low end so estimates err toward fitting.
export const CHARS_PER_TOKEN = 3.2;
const TEMPLATE_OVERHEAD_TOKENS = 96;
export const IMAGE_TOKENS = 1600;

export function planBudget({
  windowTokens = null,
  settings = {},
  small = false,
  systemChars = 0,
  schemaChars = 0,
  image = false
} = {}) {
  const configuredOut = Number(settings.maxOutputTokens) || 8192;
  const configuredChars = Number(settings.contextChars) || 96e3;
  const userChars = small ? Math.min(configuredChars, 48e3) : configuredChars;
  if (!windowTokens) {
    return {
      windowTokens: null,
      maxTokens: configuredOut,
      historyChars: Math.max(6e3, userChars - systemChars),
      toolClip: 26e3,
      tight: false,
      overflow: false
    };
  }
  // Keep a quarter of the window for the reply, never more than the user asked
  // for, and never so little that a tool call cannot be written.
  const maxTokens = Math.max(384, Math.min(configuredOut, Math.floor(windowTokens * 0.25)));
  const promptTokens = windowTokens - maxTokens - TEMPLATE_OVERHEAD_TOKENS - (image ? IMAGE_TOKENS : 0);
  const windowChars = Math.max(0, Math.floor(promptTokens * CHARS_PER_TOKEN));
  const total = Math.min(userChars, windowChars);
  const room = total - systemChars - schemaChars;
  const historyChars = Math.max(1500, room);
  return {
    windowTokens,
    maxTokens,
    historyChars,
    // One tool result may take at most half the history room, so the request
    // and the model's last step survive alongside it.
    toolClip: Math.max(1500, Math.min(26e3, Math.floor(historyChars * 0.5))),
    tight: room < 12e3,
    overflow: room < 1500
  };
}

export function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / CHARS_PER_TOKEN);
}
