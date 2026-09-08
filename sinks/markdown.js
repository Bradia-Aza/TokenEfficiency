// Canonical objects -> markdown. Reads only the canonical model and a ctx, so
// it renders any provider's traffic; it never touches wire bytes.

import { BLOCK, STOP_REASON, TOOL_KIND } from '../canonical/index.js';

/**
 * A code fence long enough to survive its own contents. Transcripts are full of
 * source code and markdown, so a three-backtick fence would be broken open by
 * roughly every interesting tool result.
 */
function fenced(text, lang = '') {
  const longestRun = [...String(text).matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

const quoted = (text) =>
  String(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const json = (value) => JSON.stringify(value, null, 2);

/** Payloads are described, never inlined: one image would dwarf the turn. */
function describeMedia(source) {
  const where =
    source.url ??
    source.id ??
    (source.data === null ? 'no payload' : `${Math.floor(source.data.length * 0.75)} bytes, ${source.kind}`);
  return `**attachment** — ${source.mediaType ?? 'unknown type'} (${where})`;
}

/**
 * Where the prompt cache is asked to break. This is the request-side half of
 * the cache-read and cache-write numbers in the ledger, so it belongs in the
 * transcript beside the content it applies to.
 */
function cacheNote(cache) {
  const ttl = cache.ttlSeconds === null ? '' : ` — ttl ${cache.ttlSeconds}s`;
  return `_cache breakpoint${ttl}_`;
}

/** A provider-executed tool is not the client's to answer, or a transform's to rewrite. */
const kindNote = (block) => (block.kind === TOOL_KIND.PROVIDER ? ' _(provider-executed)_' : '');

function blockToMarkdown(block, originalBlock) {
  let body = renderBlock(block);
  if (
    originalBlock !== undefined &&
    originalBlock.type === BLOCK.TEXT &&
    block.type === BLOCK.TEXT &&
    originalBlock.text !== block.text
  ) {
    body += `\n\n_before transform:_\n\n${quoted(originalBlock.text)}`;
  }
  return block.cache ? `${body}\n\n${cacheNote(block.cache)}` : body;
}

function renderBlock(block) {
  switch (block.type) {
    case BLOCK.TEXT:
      return block.text;

    case BLOCK.THINKING:
      if (block.redacted) return `**thinking** _(redacted by the provider)_`;
      return `**thinking**\n\n${quoted(block.thinking)}`;

    case BLOCK.TOOL_CALL:
      return `**tool call** \`${block.name}\` _(${block.id})_${kindNote(block)}\n\n${fenced(json(block.input), 'json')}`;

    case BLOCK.TOOL_RESULT: {
      const name = block.name === null ? '' : ` \`${block.name}\``;
      const header = `**tool result**${name} _(${block.callId})_${kindNote(block)}${block.isError ? ' — **error**' : ''}`;
      const body = block.content
        .map((inner) => (inner.type === BLOCK.TEXT ? fenced(inner.text) : blockToMarkdown(inner)))
        .join('\n\n');
      return `${header}\n\n${body}`;
    }

    case BLOCK.JSON:
      return fenced(json(block.data), 'json');

    case BLOCK.MEDIA:
      return describeMedia(block.source);

    case BLOCK.UNKNOWN:
      // Worth showing rather than hiding: an unmodeled block in a transcript is
      // a standing prompt to ask whether the model should grow to cover it.
      return `**unmodeled block** \`${block.raw?.type ?? 'unknown'}\`\n\n${fenced(json(block.raw), 'json')}`;

    default:
      return `**unrenderable block** \`${block.type}\``;
  }
}

const contentToMarkdown = (content, originalContent) =>
  content.map((block, i) => blockToMarkdown(block, originalContent?.[i])).join('\n\n');

function usageLine(usage) {
  if (usage === null) return '_no usage reported_';
  const cell = (n) => (n === null ? '—' : n.toLocaleString('en-US'));
  return [
    `input ${cell(usage.inputTokens)}`,
    `output ${cell(usage.outputTokens)}`,
    `reasoning ${cell(usage.reasoningTokens)}`,
    `cache read ${cell(usage.cacheReadTokens)}`,
    `cache write ${cell(usage.cacheWriteTokens)}`,
    `total ${cell(usage.totalTokens)}`,
  ].join(' · ');
}

/**
 * The whole conversation as of this turn.
 *
 * The request carries the full history the client sent, so the transcript is
 * rewritten from the newest request plus its response rather than appended to.
 * That means it always shows the conversation as the model actually saw it this
 * turn — including what a compaction dropped.
 *
 * @param {object} args
 * @param {object} args.request canonical request
 * @param {object|null} args.response canonical response, null when unmodelable
 * @param {object} args.ctx observation context
 */
export function renderTranscript({ request, response, ctx }) {
  const turns = [
    ...request.messages,
    ...(response !== null ? [{ role: response.role, content: response.content }] : []),
  ];
  // Present only in transform mode. Indexed the same way `turns` is built
  // above, so a message's markdown can be paired with what the client
  // actually wrote before the transform touched it; the response has no
  // pre-transform counterpart since no response transform exists.
  const originalMessages = ctx.transform?.originalRequest?.messages ?? null;
  const originalSystem = ctx.transform?.originalRequest?.system ?? null;

  const out = [
    `# Session ${ctx.sessionId}`,
    '',
    [
      `- **provider** \`${ctx.provider}\``,
      `- **model** \`${request.model ?? 'unspecified'}\``,
      `- **endpoint** \`${ctx.method} ${ctx.path}\``,
      `- **turns** ${turns.length}`,
      `- **updated** ${new Date(ctx.finishedAt ?? Date.now()).toISOString()}`,
      ...(ctx.transform !== null && ctx.transform !== undefined
        ? [`- **transform** ${ctx.transform.transformed ? `${ctx.transform.edits} edit(s) applied` : 'no edits'}`]
        : []),
    ].join('\n'),
  ];

  if (request.system !== null && request.system.length > 0) {
    out.push('', '## System', '', contentToMarkdown(request.system, originalSystem));
  }

  if (request.tools !== null && request.tools.length > 0) {
    out.push(
      '',
      '## Tools offered',
      '',
      request.tools
        .map(
          (tool) =>
            `- \`${tool.name}\`${tool.kind === TOOL_KIND.PROVIDER ? ' _(provider-executed)_' : ''} — ` +
            `${tool.description ?? '_no description_'}`,
        )
        .join('\n'),
    );
  }

  out.push('', '## Conversation');
  turns.forEach((turn, index) => {
    // originalMessages only covers request turns; the response (appended
    // after them) has no pre-transform counterpart to pair with.
    const originalContent = originalMessages !== null && index < originalMessages.length
      ? originalMessages[index]?.content
      : undefined;
    out.push(
      '',
      `### ${index + 1} · ${turn.role}`,
      '',
      contentToMarkdown(turn.content, originalContent) || '_empty turn_',
    );
  });

  if (response !== null) {
    const stop = response.stopReason === null ? 'none reported' : response.stopReason;
    const detail = response.stopReason === STOP_REASON.OTHER ? ` (\`${response.raw?.stop_reason}\`)` : '';
    out.push(
      '',
      '---',
      '',
      `**stop reason** \`${stop}\`${detail}${ctx.streamed ? ' · streamed' : ''}`,
      '',
      usageLine(response.usage),
    );
    if (response.error !== null) {
      out.push('', `**error** \`${response.error.type ?? 'unknown'}\` — ${response.error.message ?? ''}`);
    }
  } else {
    out.push('', '---', '', '_the response for this turn could not be modeled; it was forwarded unchanged_');
  }

  return `${out.join('\n')}\n`;
}

/** The human half of the token ledger. The machine half is the JSON beside it. */
export function renderLedger({ sessionId, provider, turns, totals }) {
  const cell = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
  const hasTransform = turns.some((turn) => turn.transform !== null && turn.transform !== undefined);

  const rows = turns.map((turn) => {
    const base = [
      turn.turn,
      new Date(turn.at).toISOString().slice(11, 19),
      turn.model ?? '—',
      cell(turn.inputTokens),
      cell(turn.outputTokens),
      cell(turn.reasoningTokens),
      cell(turn.cacheReadTokens),
      cell(turn.cacheWriteTokens),
      cell(turn.totalTokens),
      turn.stopReason ?? '—',
      cell(turn.durationMs),
    ];
    if (!hasTransform) return base.join(' | ');
    const t = turn.transform;
    const transformCells =
      t === null || t === undefined
        ? ['—', '—', '—']
        : [
            cell(t.requestBytesBefore),
            cell(t.requestBytesAfter),
            t.overCap ? `${cell(t.edits)} (over cap)` : cell(t.edits),
          ];
    return [...base, ...transformCells].join(' | ');
  });

  const header = hasTransform
    ? '| turn | at | model | input | output | reasoning | cache read | cache write | total | stop | ms | bytes before | bytes after | edits |'
    : '| turn | at | model | input | output | reasoning | cache read | cache write | total | stop | ms |';
  const divider = hasTransform
    ? '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |'
    : '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |';

  return [
    `# Tokens — session ${sessionId}`,
    '',
    `- **provider** \`${provider}\``,
    `- **turns** ${totals.turns}`,
    `- **bytes on the wire** ${cell(totals.requestBytes)} up · ${cell(totals.responseBytes)} down`,
    '',
    header,
    divider,
    ...rows.map((row) => `| ${row} |`),
    '',
    '**totals** ' +
      [
        `input ${cell(totals.inputTokens)}`,
        `output ${cell(totals.outputTokens)}`,
        `reasoning ${cell(totals.reasoningTokens)}`,
        `cache read ${cell(totals.cacheReadTokens)}`,
        `cache write ${cell(totals.cacheWriteTokens)}`,
        `total ${cell(totals.totalTokens)}`,
      ].join(' · '),
    '',
  ].join('\n');
}
