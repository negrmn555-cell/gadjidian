import { getSearchIndex, isPreferencesPath, parseMarkdownDocument, resolveVaultLink, vaultLinks, type NoteGraph, type Vault } from '@relay/core';

interface TagNode { type:string; value?:string; children?:TagNode[] }
function inlineTags(node: TagNode): string[] {
  if (node.type === 'text') return [...(node.value ?? '').matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_\/-]*)/gu)].map(match => match[1]);
  if (node.type === 'code' || node.type === 'inlineCode') return [];
  return (node.children ?? []).flatMap(inlineTags);
}
const tagCache = new Map<string,string[]>();
function documentTags(path:string, content:string, hash:string):string[] {
  const cached=tagCache.get(hash);if(cached)return cached;
  const tags=inlineTags(parseMarkdownDocument(path,content).ast);
  if(tagCache.size>=1024)tagCache.delete(tagCache.keys().next().value!);
  tagCache.set(hash,tags);return tags;
}

export async function notesGraph(vault: Vault, revision: string | null, syncMode: string): Promise<NoteGraph> {
  return vault.readConsistent(async () => {
    const docs = (await getSearchIndex(vault).documents(true)).filter(d => !isPreferencesPath(d.meta.path));
    const nodes = docs.map(({ parsed, meta }) => ({ path: meta.path, title: parsed.title, kind: parsed.kind, id: parsed.noteId, tags: [...new Set([...parsed.tags, ...documentTags(meta.path,parsed.content,parsed.contentHash)].map(tag => tag.replace(/^#/, '').trim()).filter(Boolean))] }));
    const paths = nodes.map(n => n.path), ids = new Map<string, string[]>();
    for (const node of nodes) if (node.id) ids.set(node.id, [...(ids.get(node.id) ?? []), node.path]);
    const pairs = new Map<string, { source: string; target: string }>();
    const connect = (source: string, target: string) => {
      if (source === target) return;
      const key = JSON.stringify([source, target].sort());
      pairs.set(key, { source, target });
    };
    for (const { parsed, meta } of docs) {
      for (const link of vaultLinks(parsed.content)) {
        const resolved = resolveVaultLink(link, meta.path, paths);
        if (resolved.path) connect(meta.path, resolved.path);
      }
      const related = parsed.metadata.related_note_ids;
      if (Array.isArray(related)) for (const id of related) {
        const matches = ids.get(String(id));
        if (matches?.length === 1) connect(meta.path, matches[0]);
      }
    }
    return { nodes, edges: [...pairs.values()], revision, syncMode, warnings: docs.filter(d => d.parsed.metadataError).map(d => d.meta.path) };
  });
}
