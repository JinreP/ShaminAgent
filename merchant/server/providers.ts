import 'server-only';
import { GoogleGenAI, type GenerateContentConfig } from "@google/genai";
import type { MerchantEnv } from "./env";

export interface AIRequest {
  prompt: string;
  systemInstruction?: string;
  signal?: AbortSignal;
  responseMimeType?: "text/plain" | "application/json";
  responseJsonSchema?: unknown;
}
export interface AIResponse { text: string; provider: string; model: string }
export interface AIProvider { generate(request: AIRequest): Promise<AIResponse> }
export type GeminiGenerate = (request: AIRequest) => Promise<{ text?: string }>;
export type GeminiStructuredOutputMode = "json" | "schema";
export function geminiGenerateConfig(request: AIRequest, mode: GeminiStructuredOutputMode = "json"): GenerateContentConfig {
  // The official SDK converts portable JSON-schema types to its native Schema
  // representation (including nullable:true). Use that documented conversion path;
  // responseJsonSchema bypasses it and the deployed model rejected our quote schema.
  return { systemInstruction: request.systemInstruction, abortSignal: request.signal,
    responseMimeType: request.responseMimeType, responseSchema: mode === "schema" ? request.responseJsonSchema : undefined,
    httpOptions: { timeout: 30000 } };
}
export function geminiPrompt(request: AIRequest, mode: GeminiStructuredOutputMode = "json"): string {
  // Explicit JSON MIME compatibility mode avoids the deployed model's full-schema
  // HTTP 400. This is syntax-constrained JSON, with complete schema validation in Zod.
  // It does not claim the upstream model enforces every schema rule.
  return mode === "json" && request.responseJsonSchema ?
    `${request.prompt}\n\nХариуны JSON бүтэц. Бүх шаардлагатай талбарыг өг; дутуу утга null:\n${JSON.stringify(request.responseJsonSchema)}` : request.prompt;
}
export class GeminiProvider implements AIProvider {
  private readonly generateContent: GeminiGenerate;
  constructor(apiKey: string, private readonly model: string, generate?: GeminiGenerate,
    private readonly structuredOutputMode: GeminiStructuredOutputMode = "json") {
    if (!apiKey.trim() || !model.trim()) throw new Error("Gemini credentials and model are required");
    const client = generate ? undefined : new GoogleGenAI({ apiKey });
    this.generateContent = generate ?? (request => client!.models.generateContent({
      model, contents: geminiPrompt(request, this.structuredOutputMode), config: geminiGenerateConfig(request, this.structuredOutputMode),
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
  return new GeminiProvider(env.GEMINI_API_KEY ?? "", env.GEMINI_MODEL ?? "", undefined, env.GEMINI_STRUCTURED_OUTPUT_MODE);
}
export function createSpeechProvider(env: MerchantEnv): SpeechProvider {
  return env.MERCHANT_SPEECH_PROVIDER === "anir" ? new AnirSpeechProvider() : new DisabledSpeechProvider();
}
