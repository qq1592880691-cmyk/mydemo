import { describe, expect, it } from "vitest";
import { calcCost, usageFromGemini, usageFromOpenAI, type ModelRow } from "@/lib/aiRegistry";

const row = { price_input_text: 0.3, price_input_audio: 1, price_input_image: 0.5, price_output: 2.5, currency: "USD" } as ModelRow;

describe("aiRegistry", () => {
  it("音声・画像入力トークンをテキストから分離する", () => {
    const u = usageFromGemini({
      promptTokenCount: 1500,
      candidatesTokenCount: 80,
      thoughtsTokenCount: 20,
      promptTokensDetails: [
        { modality: "TEXT", tokenCount: 900 },
        { modality: "AUDIO", tokenCount: 300 },
        { modality: "IMAGE", tokenCount: 300 },
      ],
    });
    expect(u).toEqual({ inputText: 900, inputAudio: 300, inputImage: 300, output: 80, thought: 20 });
  });

  it("OpenAI 画像 API の usage を変換する", () => {
    const u = usageFromOpenAI({ input_tokens: 1300, output_tokens: 6000, input_tokens_details: { text_tokens: 100, image_tokens: 1200 } });
    expect(u).toEqual({ inputText: 100, inputAudio: 0, inputImage: 1200, output: 6000, thought: 0 });
  });

  it("100万トークン単価で費用を計算し、思考トークンは出力扱い", () => {
    const cost = calcCost(row, { inputText: 1_000_000, inputAudio: 500_000, inputImage: 200_000, output: 100_000, thought: 100_000 });
    expect(cost).toBeCloseTo(0.3 + 0.5 + 0.1 + 0.5, 8);
  });

  it("usage 無し・マスタ無しでも 0 になる", () => {
    expect(usageFromGemini(undefined)).toEqual({ inputText: 0, inputAudio: 0, inputImage: 0, output: 0, thought: 0 });
    expect(calcCost(null, { inputText: 10, inputAudio: 0, inputImage: 0, output: 10, thought: 0 })).toBe(0);
  });
});
