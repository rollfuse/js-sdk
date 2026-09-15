/**
 * A minimal, incremental Server-Sent-Events frame parser, used by
 * `ConfigurationClient`'s streaming consumer (add-configuration-streaming
 * section 7) to turn raw response-body chunks from `GET /v1/config/stream`
 * into frames/comments, without buffering the whole (unbounded, long-lived)
 * response.
 *
 * Mirrors `go-sdk`'s `readSSEFrame` (add-configuration-streaming section
 * 5, `configuration_client.go`) field-for-field, adapted from a blocking
 * line-read loop to a push-based parser suitable for consuming a Web
 * `ReadableStream`: call `push(chunk)` with each decoded text chunk read
 * from the response body, and it returns every complete frame/comment now
 * available, in order (usually zero or one, but a single chunk can
 * complete more than one frame).
 */

/** One complete, named SSE frame (`event: ...` + `data: ...` lines terminated by a blank line). */
export interface SSEFrame {
  readonly type: "frame";
  readonly event: string;
  readonly data: string;
}

/** A bare SSE comment line (`: ...`) — this platform's heartbeat. Carries no event/data of its own. */
export interface SSEComment {
  readonly type: "comment";
}

export type SSEEvent = SSEFrame | SSEComment;

export class SSEParser {
  private buffer = "";
  private currentEvent = "";
  private currentData = "";
  private sawAnyLine = false;

  /**
   * Feeds chunk (already UTF-8-decoded text) into the parser and returns
   * every complete frame/comment it can now extract. Any trailing partial
   * line is retained internally and completed by a later `push` call.
   */
  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;

    const events: SSEEvent[] = [];

    let newlineIndex: number;

    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);

      this.buffer = this.buffer.slice(newlineIndex + 1);

      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line === "") {
        // A leading run of blank lines before any field line is skipped
        // rather than treated as an empty frame — real SSE streams often
        // carry a leading blank line as a keep-alive/priming write.
        if (this.sawAnyLine) {
          events.push({ type: "frame", event: this.currentEvent, data: this.currentData });
          this.resetFrame();
        }

        continue;
      }

      if (line.startsWith(":")) {
        events.push({ type: "comment" });
        continue;
      }

      this.sawAnyLine = true;

      if (line.startsWith("event:")) {
        this.currentEvent = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        const value = line.slice("data:".length).trim();
        this.currentData = this.currentData.length > 0 ? `${this.currentData}\n${value}` : value;
      }
    }

    return events;
  }

  private resetFrame(): void {
    this.currentEvent = "";
    this.currentData = "";
    this.sawAnyLine = false;
  }
}
