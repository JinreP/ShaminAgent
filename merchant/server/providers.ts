import 'server-only';
import { GoogleGenAI } from "@google/genai";
import type { MerchantEnv } from "./env";

export interface AIRequest { prompt: string; systemInstruction?: string; signal?: AbortSignal }
export interface AIResponse { text: string; provider: string; model: string }
export interface AIProvider { generate(request: AIRequest): Promise<AIResponse> }
export type GeminiGenerate = (request: AIRequest) => Promise<{ text?: string }>;
export class GeminiProvider implements AIProvider {
  private readonly generateContent: GeminiGenerate;
  constructor(apiKey: string, private readonly model: string, generate?: GeminiGenerate) {
    if (!apiKey.trim() || !model.trim()) throw new Error("Gemini credentials and model are required");
    const client = generate ? undefined : new GoogleGenAI({ apiKey });
    this.generateContent = generate ?? (request => client!.models.generateContent({
      model, contents: request.prompt, config: { systemInstruction: request.systemInstruction,
        abortSignal: request.signal, httpOptions: { timeout: 30000 } },
    }));
  }
  async generate(request: AIRequest): Promise<AIResponse> {
    if (!request.prompt.trim()) throw new Error("Prompt is required");
    request.signal?.throwIfAborted();
    const result = await this.generateContent(request);
    if (!result.text?.trim()) throw new Error("Gemini returned no text");
    return { text: result.text, provider: "gemini", model: this.model };
  }
}
export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) { super(`${provider} integration requires documented API and credentials`); this.name = "ProviderNotConfiguredError"; }
}
export class OyuLLMProvider implements AIProvider {
  async generate(_request: AIRequest): Promise<AIResponse> { void _request; throw new ProviderNotConfiguredError("OyuLLM"); }
}
export interface SpeechRequest { audio: Uint8Array; mimeType: string; language?: string; signal?: AbortSignal }
export interface SpeechResponse { text: string; language?: string; provider: string }
export interface SpeechProvider { transcribe(request: SpeechRequest): Promise<SpeechResponse> }
export class AnirSpeechProvider implements SpeechProvider {
  async transcribe(_request: SpeechRequest): Promise<SpeechResponse> { void _request; throw new ProviderNotConfiguredError("Anir STT"); }
}
export class DisabledSpeechProvider implements SpeechProvider {
  async transcribe(_request: SpeechRequest): Promise<SpeechResponse> { void _request; throw new Error("Speech transcription is disabled"); }
}
export function createAIProvider(env: MerchantEnv): AIProvider {
  if (env.MERCHANT_AI_PROVIDER === "oyullm") return new OyuLLMProvider();
  return new GeminiProvider(env.GEMINI_API_KEY ?? "", env.GEMINI_MODEL ?? "");
}
export function createSpeechProvider(env: MerchantEnv): SpeechProvider {
  return env.MERCHANT_SPEECH_PROVIDER === "anir" ? new AnirSpeechProvider() : new DisabledSpeechProvider();
}
