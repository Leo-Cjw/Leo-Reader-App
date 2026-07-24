import { createHash } from 'node:crypto';

const TARGET_CHARS = 900;
const MAX_CHARS = 1_400;
const OVERLAP_CHARS = 180;
const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','how','in','is','it','of','on','or','that','the','this','to','was','what','when','where','which','who','why','with',
  '一个','一些','什么','以及','他们','你们','关于','其中','可以','如何','它们','我们','是否','有哪','这个','这些','那些','问题','为什么'
]);

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function markdownToPlainText(value) {
  return String(value || '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/!\[([^\]]*)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLongBlock(block) {
  if (block.text.length <= MAX_CHARS) return [block];
  const pieces = [];
  let cursor = 0;
  while (cursor < block.text.length) {
    let end = Math.min(block.text.length, cursor + TARGET_CHARS);
    if (end < block.text.length) {
      const tail = block.text.slice(cursor, Math.min(block.text.length, cursor + MAX_CHARS));
      const boundary = Math.max(tail.lastIndexOf('。', TARGET_CHARS), tail.lastIndexOf('！', TARGET_CHARS), tail.lastIndexOf('？', TARGET_CHARS), tail.lastIndexOf('. ', TARGET_CHARS), tail.lastIndexOf('\n', TARGET_CHARS), tail.lastIndexOf(' ', TARGET_CHARS));
      if (boundary >= Math.floor(TARGET_CHARS * 0.6)) end = cursor + boundary + 1;
    }
    const text = block.text.slice(cursor, end).trim();
    if (text) pieces.push({ ...block, text, startOffset: block.startOffset + cursor, endOffset: Math.min(block.endOffset, block.startOffset + end) });
    cursor = end;
  }
  return pieces;
}

function markdownBlocks(markdown, fallback = '') {
  const source = String(markdown || '');
  const blocks = [];
  let heading = '';
  let paragraph = [];
  let paragraphStart = 0;
  let offset = 0;
  const flush = (endOffset) => {
    const raw = paragraph.join('\n');
    const text = markdownToPlainText(raw);
    if (text) blocks.push(...splitLongBlock({ heading, text, startOffset: paragraphStart, endOffset }));
    paragraph = [];
  };
  for (const lineWithBreak of source.match(/.*(?:\n|$)/g) || []) {
    if (!lineWithBreak) continue;
    const line = lineWithBreak.replace(/\n$/, '');
    const headingMatch = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flush(offset);
      heading = markdownToPlainText(headingMatch[1]);
    } else if (!line.trim()) {
      flush(offset);
    } else {
      if (!paragraph.length) paragraphStart = offset;
      paragraph.push(line);
    }
    offset += lineWithBreak.length;
  }
  flush(source.length);
  if (!blocks.length && String(fallback || '').trim()) blocks.push({ heading: '', text: markdownToPlainText(fallback), startOffset: 0, endOffset: String(fallback).length });
  return blocks;
}

export function chunkArticleMarkdown({ id, title = '', excerpt = '', content = '' }) {
  const blocks = markdownBlocks(content, excerpt || title);
  const chunks = [];
  let active = [];
  let activeHeading = '';
  const flush = () => {
    if (!active.length) return;
    const text = active.map((block) => block.text).join('\n\n').trim();
    if (!text) { active = []; return; }
    const index = chunks.length;
    const contentHash = digest(text);
    chunks.push({
      id: `${id}:${index}:${contentHash.slice(0, 12)}`,
      articleId: id,
      index,
      heading: activeHeading || title || '',
      content: text,
      startOffset: Math.min(...active.map((block) => block.startOffset)),
      endOffset: Math.max(...active.map((block) => block.endOffset)),
      contentHash
    });
    const overlap = active[active.length - 1];
    active = overlap && overlap.text.length <= OVERLAP_CHARS ? [overlap] : [];
    activeHeading = active.length ? overlap.heading : '';
  };
  for (const block of blocks) {
    const length = active.reduce((sum, item) => sum + item.text.length + 2, 0);
    const headingChanged = active.length && block.heading && block.heading !== activeHeading;
    if (headingChanged) { flush(); active = []; activeHeading = ''; }
    else if (active.length && length + block.text.length > TARGET_CHARS) flush();
    if (!active.length) activeHeading = block.heading || title || '';
    active.push(block);
    if (active.reduce((sum, item) => sum + item.text.length + 2, 0) >= MAX_CHARS) flush();
  }
  flush();
  return chunks.map((chunk, index) => ({ ...chunk, index, id: `${id}:${index}:${chunk.contentHash.slice(0, 12)}` }));
}

export function ragQueryTerms(value) {
  const input = String(value || '').normalize('NFKC').toLocaleLowerCase();
  const terms = [];
  for (const token of input.match(/[\p{L}\p{N}]+/gu) || []) {
    const han = (token.match(/\p{Script=Han}/gu) || []).join('');
    if (han) {
      if (han.length <= 4) terms.push(han);
      else for (let index = 0; index < han.length - 1; index += 2) {
        const pair = han.slice(index, index + 2);
        if (pair.length === 2) terms.push(pair);
      }
      continue;
    }
    if (token.length > 1 && !STOP_WORDS.has(token)) terms.push(token);
  }
  const normalized = [...new Set(terms.map((term) => term.trim()).filter((term) => term && !STOP_WORDS.has(term)))].slice(0, 24);
  return normalized.length ? normalized : input.trim() ? [input.trim().slice(0, 80)] : [];
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (count < 4 && (cursor = haystack.indexOf(needle, cursor)) !== -1) { count += 1; cursor += needle.length; }
  return count;
}

export function scoreRagChunk(chunk, query, terms = ragQueryTerms(query)) {
  const content = String(chunk.content || '').normalize('NFKC').toLocaleLowerCase();
  const heading = String(chunk.heading || '').normalize('NFKC').toLocaleLowerCase();
  const title = String(chunk.article_title || '').normalize('NFKC').toLocaleLowerCase();
  const excerpt = String(chunk.article_excerpt || '').normalize('NFKC').toLocaleLowerCase();
  const source = String(chunk.article_source || '').normalize('NFKC').toLocaleLowerCase();
  let score = 0;
  let covered = 0;
  for (const term of terms) {
    const contentHits = occurrences(content, term);
    const headingHits = occurrences(heading, term);
    const titleHits = occurrences(title, term);
    const excerptHits = occurrences(excerpt, term);
    const sourceHits = occurrences(source, term);
    if (contentHits || headingHits || titleHits || excerptHits || sourceHits) covered += 1;
    score += contentHits + headingHits * 3.5 + titleHits * 3 + excerptHits * 2 + sourceHits * 1.5;
  }
  const exact = String(query || '').normalize('NFKC').toLocaleLowerCase().trim();
  if (exact.length > 3 && content.includes(exact)) score += 8;
  score += terms.length ? (covered / terms.length) * 5 : 0;
  score += 1 / (1 + Number(chunk.chunk_index || 0));
  return Number(score.toFixed(4));
}
