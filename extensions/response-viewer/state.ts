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
	let pending: { id: string; markdown: string } | undefined;
	let restored = 0;
	const nextRestoredId = () => `restored-${++restored}`;
	const flush = () => {
		if (!pending?.markdown.trim()) return;
		result.push({ id: pending.id, markdown: pending.markdown, status: "complete", error: null, truncated: false });
	};
	for (const entry of entries) {
		const message = messageOf(entry);
		if (!message) continue;
		if (message.role === "user") {
			flush();
			pending = { id: entryId(entry) ?? nextRestoredId(), markdown: "" };
			continue;
		}
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		const text = assistantText(message);
		if (!text.trim()) continue;
		if (!pending) pending = { id: nextRestoredId(), markdown: "" };
		pending.markdown = text;
	}
	flush();
	return result;
}

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");
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
	/** Kept separately so an empty high-level turn neither appears nor affects bounds. */
	private active: { id: string; markdown: string; failed: boolean } | undefined;

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
		this.active = { id, markdown: "", failed: false };
		return id;
	}

	/** Replace the active turn with the newest visible assistant text across tool/retry runs. */
	stream(markdown: string): void {
		if (!markdown.trim() || !this.active) return;
		this.active.markdown = markdown;
		this.active.failed = false;
		const index = this.responses.findIndex(response => response.id === this.active!.id);
		const next: ViewerResponse = { id: this.active.id, markdown, status: "running", error: null, truncated: false };
		if (index < 0) this.responses.push(next);
		else this.responses[index] = next;
		this.bound();
		this.changed();
	}

	/** Remember a low-level failure without exposing provider data or ending the high-level turn. */
	fail(): void { if (this.active) this.active.failed = true; }

	/** Finalize only after Pi reports no retry or follow-up work remains. */
	settle(errorMessage = "The response ended with an error."): void {
		const active = this.active;
		this.active = undefined;
		if (!active?.markdown.trim()) return;
		const index = this.responses.findIndex(response => response.id === active.id);
		if (index < 0) return; // stream() is the only path that makes a visible response.
		this.responses[index] = {
			...this.responses[index],
			status: active.failed ? "error" : "complete",
			error: active.failed ? errorMessage : null,
		};
		this.bound();
		this.changed();
	}

	close(): void { this.closed = true; this.active = undefined; this.changed(); }

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
