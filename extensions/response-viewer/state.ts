export type ViewerStatus = "waiting" | "running" | "complete" | "error" | "closed";
export type ResponseStatus = Exclude<ViewerStatus, "waiting" | "closed">;

export type ViewerResponse = Readonly<{
	id: string;
	markdown: string;
	status: ResponseStatus;
	error: string | null;
	truncated: boolean;
}>;

export type ViewerSnapshot = Readonly<{
	status: ViewerStatus;
	responses: readonly ViewerResponse[];
	latestId: string | null;
	revision: number;
}>;

type AssistantLike = { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
type EntryLike = { type?: unknown; id?: unknown; message?: AssistantLike };

export const MAX_RESPONSES = 30;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** A turn speaks once per assistant message. The rule marks where tool work happened between them. */
export const SEGMENT_SEPARATOR = "\n\n---\n\n";

const joinSegments = (segments: readonly string[]): string => segments.filter(segment => segment.trim()).join(SEGMENT_SEPARATOR);

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * A turn holds every message of one prompt, so it can outgrow the byte cap on its own. Drop whole
 * oldest messages rather than let a byte prefix survive: the newest text is what the reader needs.
 * `newest` is never dropped, leaving a single oversized message to the existing prefix truncation.
 */
function fitSegments(older: string[], newest: string): { markdown: string; truncated: boolean } {
	let truncated = false;
	let markdown = joinSegments([...older, newest]);
	while (older.length > 0 && utf8Bytes(markdown) > MAX_RESPONSE_BYTES) {
		older.shift();
		truncated = true;
		markdown = joinSegments([...older, newest]);
	}
	return { markdown, truncated };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/**
 * Close a fence left open by a message the token limit cut off. Without this the separator and
 * every later message of the turn are swallowed into that unterminated code block. Opening and
 * closing fences are told apart by CommonMark's rules, so an info string cannot flip the state.
 */
export function closeOpenFence(markdown: string): string {
	let open: string | undefined;
	for (const line of markdown.split("\n")) {
		const match = FENCE.exec(line);
		if (!match) continue;
		const [, delimiter, rest] = match;
		if (open === undefined) {
			if (delimiter[0] === "`" && rest.includes("`")) continue; // A backtick opener takes no backtick in its info string.
			open = delimiter;
			continue;
		}
		if (delimiter[0] === open[0] && delimiter.length >= open.length && !rest.trim()) open = undefined; // A closer carries no info string.
	}
	return open ? `${markdown}\n${open}` : markdown;
}

/** Extract only visible assistant text. Thinking, tool calls, and tool results never enter the viewer. */
export function assistantText(message: AssistantLike | undefined): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

const messageOf = (entry: unknown): AssistantLike | undefined => entry && typeof entry === "object" && "message" in entry
	? (entry as EntryLike).message
	: entry as AssistantLike;
const entryId = (entry: unknown): string | undefined => entry && typeof entry === "object" && typeof (entry as EntryLike).id === "string" && (entry as EntryLike).id
	? (entry as EntryLike).id as string
	: undefined;

/** Group persisted branch messages into one visible response for each user turn. */
export function responseHistory(entries: Iterable<unknown>): ViewerResponse[] {
	const result: ViewerResponse[] = [];
	let pending: { id: string; segments: string[] } | undefined;
	let restored = 0;
	const nextRestoredId = () => `restored-${++restored}`;
	const flush = () => {
		const newest = pending?.segments.at(-1);
		if (!pending || !newest) return;
		const { markdown, truncated } = fitSegments(pending.segments.slice(0, -1), newest);
		if (!markdown.trim()) return;
		result.push({ id: pending.id, markdown, status: "complete", error: null, truncated });
	};
	for (const entry of entries) {
		const message = messageOf(entry);
		if (!message) continue;
		if (message.role === "user") {
			flush();
			pending = { id: entryId(entry) ?? nextRestoredId(), segments: [] };
			continue;
		}
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		const text = assistantText(message);
		if (!text.trim()) continue;
		if (!pending) pending = { id: nextRestoredId(), segments: [] };
		pending.segments.push(closeOpenFence(text));
	}
	flush();
	return result;
}

const truncateUtf8 = (value: string, limit: number): string => {
	let bytes = 0;
	let end = 0;
	for (const character of value) {
		const size = utf8Bytes(character);
		if (bytes + size > limit) break;
		bytes += size;
		end += character.length;
	}
	return value.slice(0, end);
};
const copyResponse = (response: ViewerResponse): ViewerResponse => ({ ...response });

/** In-memory response history. It never receives user content and is bounded by count and UTF-8 bytes. */
export class ViewerState {
	private responses: ViewerResponse[] = [];
	private revision = 0;
	private closed = false;
	private live = 0;
	/**
	 * Kept separately so an empty high-level turn neither appears nor affects bounds.
	 * `done` holds the text of assistant messages this turn has already finished; `current`
	 * holds the message still being streamed, so deltas and retries replace only the latter.
	 */
	private active: { id: string; done: string[]; current: string; failed: boolean; dropped: boolean } | undefined;

	snapshot(): ViewerSnapshot {
		const latest = this.responses.at(-1);
		const status: ViewerStatus = this.closed ? "closed" : latest?.status ?? "waiting";
		return Object.freeze({
			status,
			responses: Object.freeze(this.responses.map(response => Object.freeze(copyResponse(response)))),
			latestId: latest?.id ?? null,
			revision: this.revision,
		});
	}

	restore(responses: Iterable<ViewerResponse>): void {
		this.closed = false;
		this.active = undefined;
		this.responses = [...responses].map(copyResponse);
		this.bound();
		this.changed();
	}

	/** Begin exactly one high-level user turn. This is deliberately invisible until text arrives. */
	beginTurn(): string {
		this.closed = false;
		if (this.active) return this.active.id;
		const id = `live-${++this.live}`;
		this.active = { id, done: [], current: "", failed: false, dropped: false };
		return id;
	}

	/** Close the streaming message so the next one appends to the turn instead of replacing it. */
	beginMessage(): void {
		if (!this.active) return;
		if (this.active.current.trim()) this.active.done.push(closeOpenFence(this.active.current));
		this.active.current = "";
	}

	/** Replace the streaming message's text, keeping the earlier messages of the same turn. */
	stream(markdown: string): void {
		if (!markdown.trim() || !this.active) return;
		this.active.current = markdown;
		this.active.failed = false;
		const joined = this.fit(this.active);
		const index = this.responses.findIndex(response => response.id === this.active!.id);
		const next: ViewerResponse = { id: this.active.id, markdown: joined, status: "running", error: null, truncated: this.active.dropped };
		if (index < 0) this.responses.push(next);
		else this.responses[index] = next;
		this.bound();
		this.changed();
	}

	/**
	 * Remember a low-level failure without exposing provider data or ending the high-level turn.
	 * The failed message's partial text is dropped so a retry replaces it rather than doubling it,
	 * while already-finished messages of the turn survive. The last published text is left alone so
	 * a turn that never retries keeps showing what the reader already saw.
	 */
	fail(): void {
		if (!this.active) return;
		this.active.failed = true;
		this.active.current = "";
	}

	/** Finalize only after Pi reports no retry or follow-up work remains. */
	settle(errorMessage = "The response ended with an error."): void {
		const active = this.active;
		this.active = undefined;
		if (!active) return;
		const index = this.responses.findIndex(response => response.id === active.id);
		if (index < 0) return; // stream() is the only path that makes a visible response.
		// A last message the token limit cut off inside a fence would bleed into whatever follows it
		// — the next response in an export — and would not match what a reload rebuilds.
		const closed = closeOpenFence(active.current);
		this.responses[index] = {
			...this.responses[index],
			markdown: closed === active.current ? this.responses[index].markdown : joinSegments([...active.done, closed]),
			status: active.failed ? "error" : "complete",
			error: active.failed ? errorMessage : null,
		};
		this.bound();
		this.changed();
	}

	/**
	 * End the visible turn at a prompt injected into a running agent loop and open the next one.
	 * A turn that has produced no text yet simply continues, so an ordinary prompt is not a split.
	 */
	splitTurn(errorMessage: string): boolean {
		// A prompt typed during retry backoff must not split: the retry would restate the failed
		// message's text in a new response and leave a spurious error turn behind it.
		if (!this.active || this.active.failed) return false;
		if (!this.responses.some(response => response.id === this.active!.id)) return false;
		this.settle(errorMessage);
		this.beginTurn();
		return true;
	}

	close(): void { this.closed = true; this.active = undefined; this.changed(); }

	private fit(active: { done: string[]; current: string; dropped: boolean }): string {
		const { markdown, truncated } = fitSegments(active.done, active.current);
		if (truncated) active.dropped = true; // Sticky: later messages fit again, text is still gone.
		return markdown;
	}

	private bound(): void {
		if (this.responses.length > MAX_RESPONSES) this.responses.splice(0, this.responses.length - MAX_RESPONSES);
		while (this.responses.length > 1 && this.totalBytes() > MAX_RESPONSE_BYTES) this.responses.shift();
		const latest = this.responses.at(-1);
		if (latest && utf8Bytes(latest.markdown) > MAX_RESPONSE_BYTES) {
			this.responses[this.responses.length - 1] = { ...latest, markdown: truncateUtf8(latest.markdown, MAX_RESPONSE_BYTES), truncated: true };
		}
	}

	private totalBytes(): number { return this.responses.reduce((total, response) => total + utf8Bytes(response.markdown), 0); }
	private changed(): void { this.revision += 1; }
}
