/**
 * Co-Ober - File Link Utilities
 *
 * Detects Obsidian wikilinks [[path/to/file]] in rendered content and makes
 * them clickable to open the file in Obsidian.
 *
 * @see reference projects/claudian-2.0.16/src/utils/fileLink.ts
 */

import type { App } from 'obsidian';

/**
 * Regex pattern to match Obsidian wikilinks in text content.
 * Matches [[note]], [[folder/note]], [[note|display text]], [[note#heading]].
 * Does NOT match image embeds ![[image.png]].
 */
const WIKILINK_PATTERN_SOURCE = '(?<!!)\\[\\[([^\\]|#^]+)(?:#[^\\]|]+)?(?:\\^[^\\]|]+)?(?:\\|[^\\]]+)?\\]\\]';

function createWikilinkPattern(): RegExp {
  return new RegExp(WIKILINK_PATTERN_SOURCE, 'g');
}

interface WikilinkMatch {
  index: number;
  fullMatch: string;
  linkPath: string;
  linkTarget: string;
  displayText: string;
}

function fileExistsInVault(app: App, linkPath: string): boolean {
  const file = app.metadataCache.getFirstLinkpathDest(linkPath, '');
  if (file) return true;

  // Also try direct path lookup
  const vaultFile = app.vault.getAbstractFileByPath(linkPath);
  if (vaultFile) return true;

  if (!linkPath.endsWith('.md')) {
    const withExt = app.vault.getAbstractFileByPath(linkPath + '.md');
    if (withExt) return true;
  }

  return false;
}

function buildWikilinkMatch(fullMatch: string, linkPath: string, index: number): WikilinkMatch {
  const pipeIndex = fullMatch.lastIndexOf('|');
  const displayText = pipeIndex > 0 ? fullMatch.slice(pipeIndex + 1, -2) : linkPath;
  const inner = fullMatch.slice(2, -2);
  const targetPipeIndex = inner.indexOf('|');
  const linkTarget = targetPipeIndex >= 0 ? inner.slice(0, targetPipeIndex) : inner;

  return { index, fullMatch, linkPath, linkTarget, displayText };
}

function findWikilinks(app: App, text: string): WikilinkMatch[] {
  const pattern = createWikilinkPattern();
  const matches: WikilinkMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const linkPath = match[1];
    if (!fileExistsInVault(app, linkPath)) continue;
    matches.push(buildWikilinkMatch(fullMatch, linkPath, match.index));
  }

  return matches.sort((a, b) => b.index - a.index);
}

function createWikilink(ownerDocument: Document, linkTarget: string, displayText: string): HTMLAnchorElement {
  const link = ownerDocument.createElement('a');
  link.className = 'co-ober-file-link internal-link';
  link.textContent = displayText;
  link.setAttribute('data-href', linkTarget);
  link.setAttribute('href', linkTarget);
  return link;
}

function buildFragmentWithLinks(ownerDocument: Document, text: string, matches: WikilinkMatch[]): DocumentFragment {
  const fragment = ownerDocument.createDocumentFragment();
  let currentIndex = text.length;

  for (const { index, fullMatch, linkTarget, displayText } of matches) {
    const endIndex = index + fullMatch.length;
    if (endIndex < currentIndex) {
      fragment.insertBefore(ownerDocument.createTextNode(text.slice(endIndex, currentIndex)), fragment.firstChild);
    }
    fragment.insertBefore(createWikilink(ownerDocument, linkTarget, displayText), fragment.firstChild);
    currentIndex = index;
  }

  if (currentIndex > 0) {
    fragment.insertBefore(ownerDocument.createTextNode(text.slice(0, currentIndex)), fragment.firstChild);
  }

  return fragment;
}

function processTextNode(app: App, node: Text): boolean {
  const text = node.textContent;
  if (!text || !text.includes('[[')) return false;
  const matches = findWikilinks(app, text);
  if (matches.length === 0) return false;
  node.parentNode?.replaceChild(buildFragmentWithLinks(node.ownerDocument, text, matches), node);
  return true;
}

/**
 * Call after MarkdownRenderer.render().
 * Catches wikilinks that remain as raw text after rendering (especially in inline code spans).
 */
export function processFileLinks(app: App, container: HTMLElement): void {
  if (!app || !container) return;

  // Repair resolved internal links that rendered as empty anchors
  container.querySelectorAll('a.internal-link').forEach((linkEl) => {
    const link = linkEl as HTMLAnchorElement;
    if ((link.textContent || '').trim()) return;
    const linkTarget = link.dataset.href || link.getAttribute('data-href') || link.getAttribute('href');
    if (!linkTarget) return;
    const linkPath = linkTarget.replace(/[#^].*$/, '');
    if (!linkPath || !fileExistsInVault(app, linkPath)) return;
    link.classList.add('co-ober-file-link');
    if (!link.dataset.href) link.setAttribute('data-href', linkTarget);
    link.textContent = linkTarget;
  });

  // Wikilinks in inline code aren't rendered by Obsidian's MarkdownRenderer
  container.querySelectorAll('code').forEach((codeEl) => {
    if (codeEl.parentElement?.tagName === 'PRE') return;
    const text = codeEl.textContent;
    if (!text || !text.includes('[[')) return;
    const matches = findWikilinks(app, text);
    if (matches.length === 0) return;
    codeEl.textContent = '';
    codeEl.appendChild(buildFragmentWithLinks(container.ownerDocument, text, matches));
  });

  // Walk through text nodes and convert wikilinks
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tagName = parent.tagName.toUpperCase();
      if (tagName === 'PRE' || tagName === 'CODE' || tagName === 'A') return NodeFilter.FILTER_REJECT;
      if (parent.closest('pre, code, a, .co-ober-file-link, .internal-link')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);
  for (const textNode of textNodes) processTextNode(app, textNode);
}

/**
 * Registers a delegated click handler for file links on a container.
 * Should be called once on the messages container.
 * Handles both custom .co-ober-file-link and Obsidian's .internal-link.
 */
export function registerFileLinkHandler(app: App, container: HTMLElement): void {
  container.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const link = target.closest('.co-ober-file-link, .internal-link') as HTMLAnchorElement;
    if (link) {
      event.preventDefault();
      const linkTarget = link.dataset.href || link.getAttribute('href');
      if (linkTarget) {
        void app.workspace.openLinkText(linkTarget, '', 'tab');
      }
    }
  });
}
