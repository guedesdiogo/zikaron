// WebCrypto, TextEncoder, timers and AbortController exist in every runtime Kelpie targets (workerd and Node), but this
// package compiles without DOM or Node typings to stay runtime-agnostic, so it declares what it uses.
// Its tests compile against workerd's own types instead.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
  readonly subtle: {
    digest(algorithm: "SHA-1" | "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  };
};
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(timer: unknown): void;
interface AbortSignal {
  readonly aborted: boolean;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
