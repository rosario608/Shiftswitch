import { assistedImportLimits } from "./limits";

/**
 * The call to the model, behind a transport.
 *
 * Same shape as the push and email transports, and for the same reason: the
 * domain must not depend on a vendor, and a deployment with no credentials
 * must say so rather than fail at the moment somebody presses a button. What
 * is different here is why the seam earns its keep in *tests*:
 * `npm run verify` runs offline and must stay deterministic, so every test
 * substitutes a transport that replays a recorded response. Nothing in the
 * suite reaches the network, and no test needs a key.
 *
 * ## Why not the SDK
 *
 * `@anthropic-ai/sdk` would be a second HTTP client, a second retry policy and
 * a second thing to keep current, for one endpoint whose request body this file
 * already has to construct explicitly. `fetch` is in the runtime. The seam,
 * not the client library, is what makes this testable.
 *
 * ## The key
 *
 * `ANTHROPIC_API_KEY`, the same variable anything else in this environment
 * would use. There is deliberately no second name for it: a feature that
 * invents its own credential variable is a feature somebody configures twice
 * and rotates once.
 */

export interface ModelTextBlock {
  type: "text";
  text: string;
}

export interface ModelImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface ModelDocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
}

export type ModelContentBlock = ModelTextBlock | ModelImageBlock | ModelDocumentBlock;

export interface ModelRequest {
  system: string;
  content: ModelContentBlock[];
  maxTokens: number;
}

export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ModelTransport {
  readonly name: string;
  readonly configured: boolean;
  /** Present when `configured` is false: what is missing, in plain words. */
  readonly unavailableReason?: string;
  send(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * What a deployment with no key has. It refuses rather than pretending, and
 * the refusal is the sentence shown on the upload screen.
 */
export class UnconfiguredModelTransport implements ModelTransport {
  readonly name = "unconfigured";
  readonly configured = false;
  readonly unavailableReason =
    "Reading a schedule out of a PDF, a screenshot or a messy spreadsheet needs an Anthropic API key, and this deployment does not have one. The CSV and Excel template still works and needs nothing.";

  async send(): Promise<ModelResponse> {
    throw new Error(this.unavailableReason);
  }
}

export const DEFAULT_MODEL = process.env.ASSISTED_IMPORT_MODEL ?? "claude-sonnet-4-5";

export class AnthropicModelTransport implements ModelTransport {
  readonly name = "anthropic";
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly baseUrl: string = process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com",
  ) {}

  async send(request: ModelRequest): Promise<ModelResponse> {
    const { timeoutMs } = assistedImportLimits();
    const abort = AbortSignal.timeout(timeoutMs);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal: abort,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.content }],
      }),
    });

    if (!response.ok) {
      /* The body may carry a useful sentence and may carry nothing. Neither is
         allowed to leak the key, which is only ever in a header. */
      const detail = await response.text().catch(() => "");
      throw new Error(
        `The extraction service answered ${response.status}. ${
          detail.slice(0, 300) || "No detail was returned."
        }`,
      );
    }

    const body = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };

    const text = (body.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    return {
      text,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      model: body.model ?? this.model,
    };
  }
}

/**
 * The transport this deployment actually has.
 *
 * Read per call rather than cached at module load, so a key added to the
 * environment takes effect on the next request and so a test can set and
 * unset one without reloading modules.
 */
export function modelTransport(): ModelTransport {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? new AnthropicModelTransport(key) : new UnconfiguredModelTransport();
}
