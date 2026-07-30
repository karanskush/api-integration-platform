// Sanitizes a client-supplied conversation before it reaches the model.
//
// Multi-turn asking means the client now posts back what it claims the assistant
// said and what it claims our tools returned. The governing rule of this file is
// that none of that is trusted:
//
//   assistant TEXT   replayed verbatim but length-capped
//   tool RESULTS     re-derived from scratch, server-side, every turn
//   everything else  dropped by allowlist
//
// The attack this exists to stop is not a jailbreak, it is GROUNDING FORGERY. A
// client posts a `tool-docentapi_trace_field` part whose output claims
// `customerId` comes from `GET /admin/keys`, and the model repeats it as a cited
// fact — because it is correctly obeying its instruction to ground answers in
// tool results rather than in its own recall. That turns the one guarantee this
// product sells into an injection vector, and no amount of system-prompt wording
// fixes it: the forged text is indistinguishable from a real tool result by
// construction.
//
// Dropping tool parts instead of re-deriving them would be safe but wrong: an
// assistant turn that says "the two operations I found" with no tool result
// behind it invites the model to reconstruct from memory, which is the exact
// failure systemInstructions exists to prevent. Re-deriving is cheap because
// advisor tools are pure in-process reads over the stored model — no upstream
// request, no credential use (advisor/index.ts:10-13).
//
// Same enforcement-over-instruction discipline as deepEnrich's `shown`
// admit-list and clarify/triage's verifyQuote: the prompt may ask, but the code
// decides.

import { generateId, getToolName, isToolUIPart, type UIMessage } from 'ai';
import Ajv, { type ValidateFunction } from 'ajv';
import { ADVISOR_TOOLS, callAdvisorTool, type AdvisorContext } from './advisor';
import { AskInputError } from './ask';

// Unchanged from the single-shot contract, and still per USER MESSAGE — the
// existing test asserting /1000 characters/ still describes the same limit.
export const MAX_QUESTION_LENGTH = 1000;
// 12 exchanges. Long enough that nobody hits it in a real session, short enough
// that a thread cannot be used as a prompt-stuffing channel.
export const MAX_MESSAGES = 24;
export const MAX_ASSISTANT_REPLAY_CHARS = 4000;
export const MAX_TOTAL_CHARS = 24_000;
// = MAX_STEPS in ask.ts: one turn cannot legitimately have produced more tool
// calls than the model was allowed to make.
export const MAX_TOOL_PARTS_PER_MESSAGE = 6;

const TOOL_PART_PREFIX = 'tool-';

// Compiled once. Validation here is a filter, not a gate: an input that fails
// drops its part rather than failing the request, because a stale thread from a
// previous deploy is a normal thing to receive, not an attack.
const ajv = new Ajv({ allErrors: false, strict: false });
const validators = new Map<string, ValidateFunction>(
  ADVISOR_TOOLS.map((d) => [d.name, ajv.compile(d.inputSchema)]),
);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Re-runs the tool and returns ITS output. Whatever the client sent as `output`
// is discarded without being looked at.
function rederiveToolPart(
  part: Record<string, unknown>,
  ctx: AdvisorContext,
): UIMessage['parts'][number] | null {
  const name = getToolName(part as Parameters<typeof getToolName>[0]);
  const validate = validators.get(name);
  if (!validate) return null; // not one of ours, or renamed since this thread was written

  const input = isPlainObject(part.input) ? part.input : {};
  if (!validate(input)) return null;

  let output: unknown;
  try {
    const outcome = callAdvisorTool(name, input, ctx);
    const text = outcome.content[0]?.text ?? '{}';
    try {
      output = JSON.parse(text);
    } catch {
      output = { text };
    }
  } catch {
    // callAdvisorTool has no try/catch of its own, so this is the real guard
    // rather than a last resort. A tool that throws on replay just loses its
    // part — the turn still reads as having happened.
    return null;
  }

  return {
    type: `${TOOL_PART_PREFIX}${name}`,
    // Fresh id: a client-supplied toolCallId is an identifier we would otherwise
    // echo back into the model's context unchecked.
    toolCallId: generateId(),
    state: 'output-available',
    input,
    output,
  } as UIMessage['parts'][number];
}

function sanitizeUserParts(raw: unknown): UIMessage['parts'] {
  if (!Array.isArray(raw)) return [];
  const parts: UIMessage['parts'] = [];
  for (const part of raw) {
    if (!isPlainObject(part) || part.type !== 'text') continue;
    if (typeof part.text !== 'string') continue;
    const text = part.text.trim();
    if (!text) continue;
    if (text.length > MAX_QUESTION_LENGTH) {
      throw new AskInputError(`question must be ${MAX_QUESTION_LENGTH} characters or fewer`);
    }
    parts.push({ type: 'text', text });
  }
  return parts;
}

function sanitizeAssistantParts(raw: unknown, ctx: AdvisorContext): UIMessage['parts'] {
  if (!Array.isArray(raw)) return [];
  const parts: UIMessage['parts'] = [];
  let toolParts = 0;
  for (const part of raw) {
    if (!isPlainObject(part)) continue;

    if (part.type === 'text' && typeof part.text === 'string') {
      const text = part.text.trim();
      // Truncated rather than rejected: an over-long assistant turn is our own
      // output coming back, not user input, so refusing the whole thread would
      // punish the reader for something they did not write.
      if (text) parts.push({ type: 'text', text: text.slice(0, MAX_ASSISTANT_REPLAY_CHARS) });
      continue;
    }

    if (typeof part.type === 'string' && part.type.startsWith(TOOL_PART_PREFIX)) {
      if (toolParts >= MAX_TOOL_PARTS_PER_MESSAGE) continue;
      // A ToolUIPart carries the call AND the result in one object, so dropping
      // one drops both. That is what keeps us from ever emitting an assistant
      // tool-call with no matching tool-result, which providers reject with a 400.
      if (!isToolUIPart(part as Parameters<typeof isToolUIPart>[0])) continue;
      const rederived = rederiveToolPart(part, ctx);
      if (rederived) {
        parts.push(rederived);
        toolParts += 1;
      }
      continue;
    }

    // Everything else is dropped. Notably `file`: convertToModelMessages turns a
    // FileUIPart into { type: 'file', data: { type: 'url', url } } and the SDK's
    // download step then fetches that URL from our own egress — an SSRF
    // primitive on an endpoint that accepts no URLs at all. This codebase has
    // ssrf.ts because it takes that seriously; the ask surface stays text-only.
    // Also dropped: reasoning, source-*, data-*, custom, step-start, dynamic-tool.
  }
  return parts;
}

/**
 * Rebuilds a client-supplied thread from an allowlist, re-deriving every tool
 * result server-side. Throws AskInputError (-> 400) for shapes a client should
 * never send; silently drops parts that are merely stale or unrecognised.
 */
export function sanitizeAskMessages(raw: unknown, ctx: AdvisorContext): UIMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AskInputError('messages is required');
  }
  // Rejected, not truncated. Silently dropping the head of a thread changes the
  // answer without telling anyone; a 400 tells the client to start a new one.
  if (raw.length > MAX_MESSAGES) {
    throw new AskInputError(`a conversation may hold at most ${MAX_MESSAGES} messages`);
  }

  const out: UIMessage[] = [];
  for (const [index, message] of raw.entries()) {
    const isLast = index === raw.length - 1;
    if (!isPlainObject(message)) throw new AskInputError('each message must be an object');
    const role = message.role;

    // Rejected rather than stripped, and this is the sharpest single check in
    // the file: convertToModelMessages faithfully emits a role:'system' model
    // message from a client-supplied system UIMessage, which is a complete
    // override of systemInstructions. streamText also refuses it
    // (allowSystemInMessages defaults false) — never set that to true — but
    // failing here makes it a clean 400 instead of an error mid-stream.
    if (role === 'system') throw new AskInputError('messages may not contain a system role');
    if (role !== 'user' && role !== 'assistant') {
      throw new AskInputError('each message must have role "user" or "assistant"');
    }

    const parts =
      role === 'user' ? sanitizeUserParts(message.parts) : sanitizeAssistantParts(message.parts, ctx);

    // An empty final question is the "" case the single-shot contract answered
    // with 'question is required'. Caught here rather than after the loop,
    // because by then the empty message has been dropped and the failure would
    // report as the structural 'last message must be a question' instead —
    // technically true, but not what the caller did wrong.
    if (isLast && role === 'user' && !parts.length) {
      throw new AskInputError('question is required');
    }

    // Rebuilt from scratch, never spread: a spread would carry `metadata`,
    // provider options, and any future part-adjacent field straight through.
    // Fresh id — a client id is never echoed anywhere.
    if (parts.length) out.push({ id: generateId(), role, parts });
  }

  const last = out[out.length - 1];
  // Makes "one POST = one billable turn" well-defined, and stops a client asking
  // the model to continue an assistant turn the client itself authored.
  if (!last || last.role !== 'user') {
    throw new AskInputError('the last message must be a question');
  }

  // Measured last, on what will actually be sent. Deliberately excludes
  // re-derived tool output: that is server-authored and already capped by
  // asData(), so counting it would let a large API shrink the room a reader has
  // for their own questions.
  const totalChars = out.reduce(
    (sum, m) => sum + m.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0),
    0,
  );
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new AskInputError('this conversation is too long — start a new one');
  }

  return out;
}

/**
 * Back-compat for the single-shot `{ question }` body, so the shipped UI keeps
 * working while the streaming client lands. Remove one release after.
 */
export function messagesFromQuestion(question: unknown): unknown {
  return [{ role: 'user', parts: [{ type: 'text', text: typeof question === 'string' ? question : '' }] }];
}
