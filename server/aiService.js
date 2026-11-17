export class AiProviderError extends Error {
  // Padroniza falhas retornadas pelo provedor de IA.
  constructor(kind) {
    super("Falha no provedor de IA.");
    this.name = "AiProviderError";
    this.kind = kind;
  }
}

export function createGeminiGenerator({
  apiKey,
  model = "gemini-3.5-flash-lite",
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
}) {
  return async function generateAnswer(prompt) {
    // Valida a configuração, aplica timeout e envia o prompt ao Gemini.
    if (!apiKey) {
      throw new AiProviderError("configuration");
    }
    if (typeof fetchImpl !== "function") {
      throw new AiProviderError("configuration");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 }
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        throw new AiProviderError("provider");
      }

      const result = await response.json();
      const answer = result?.candidates
        ?.flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => part.text)
        .filter((text) => typeof text === "string")
        .join("")
        .trim();

      if (!answer) {
        throw new AiProviderError("empty-response");
      }

      return answer;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (controller.signal.aborted) {
        throw new AiProviderError("timeout");
      }
      throw new AiProviderError("provider");
    } finally {
      clearTimeout(timeout);
    }
  };
}
