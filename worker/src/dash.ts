import { XMLParser, XMLValidator } from 'fast-xml-parser';

// Read CDN locations from the authenticated manifest, never from a client hint.
export function dashResourceOrigins(xml: string, manifestUrl: URL): string[] {
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('invalid DASH manifest');
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: true });
  const document = parser.parse(xml) as Record<string, unknown>;
  if (!document.MPD || typeof document.MPD !== 'object') throw new Error('invalid DASH manifest');
  const origins = new Set([manifestUrl.origin]);
  const add = (value: string, bases: URL[]): URL[] => bases.map((base) => {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('invalid DASH resource');
    origins.add(url.origin);
    if (origins.size > 8) throw new Error('too many DASH resource origins');
    return url;
  });
  const visit = (value: unknown, bases: URL[]) => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry, bases); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    const rawBases = node.BaseURL === undefined ? [] : Array.isArray(node.BaseURL) ? node.BaseURL : [node.BaseURL];
    const localBases: URL[] = [];
    for (const entry of rawBases) {
      const text = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['#text'] : undefined;
      if (typeof text === 'string' && text.trim()) localBases.push(...add(text.trim(), bases));
      if (localBases.length > 64) throw new Error('too many DASH base locations');
    }
    const resolvedBases = localBases.length ? localBases : bases;
    for (const name of ['SegmentTemplate', 'SegmentURL', 'Initialization', 'RepresentationIndex']) {
      const entries = node[name] === undefined ? [] : Array.isArray(node[name]) ? node[name] : [node[name]];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const attributes = entry as Record<string, unknown>;
        for (const attribute of ['@_media', '@_initialization', '@_sourceURL', '@_index']) {
          if (typeof attributes[attribute] === 'string') add(attributes[attribute], resolvedBases);
        }
      }
    }
    for (const [name, child] of Object.entries(node)) {
      if (name !== 'BaseURL' && !name.startsWith('@_')) visit(child, resolvedBases);
    }
  };
  visit(document.MPD, [manifestUrl]);
  return [...origins];
}
