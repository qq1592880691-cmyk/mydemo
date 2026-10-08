import { getModel, resolveKey } from "../aiRegistry";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import { Provider } from "./types";

const gemini = new GeminiProvider();
const mock = new MockProvider();

export function getProvider(forceMock?: boolean): Provider {
  if (forceMock || process.env.MOCK === "1") return mock;
  return resolveKey(getModel("gemini", "text")) ? gemini : mock;
}
