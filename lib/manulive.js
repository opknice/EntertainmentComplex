// Resolve a channel by its published name/group, not an expiring stream or ID.
export async function resolveManuLive(readJson, selection = '', selectionRevision = '') {
  const config = await readJson('/manulive.json');
  if (!['ott', 'live', 'sports'].includes(config.section) || typeof config.title !== 'string' || typeof config.group !== 'string') throw new Error('invalid channel configuration');
  const revision = JSON.stringify([config.section, config.group, config.title]);
  const title = selection && selectionRevision === revision ? selection : config.title;
  const catalog = await readJson(config.section === 'ott' ? '/data/version.json' : '/data/catalog.json');
  let items, selected;
  if (config.section === 'ott') {
    const indexUrl = catalog.ottSummary?.indexUrl;
    if (!/^\/data\/ott\/[a-z0-9-]+\/index\.json$/.test(indexUrl || '')) throw new Error('invalid OTT generation');
    const index = await readJson(indexUrl);
    if (!/^\/data\/ott\/[a-z0-9-]+$/.test(index.partsBase || '')) throw new Error('invalid OTT parts');
    items = index.entries.filter(entry => entry[2] === config.group).map(([id, name, group, part]) => ({ id, title: name, group, part }));
    const entry = items.find(item => item.title === title);
    if (entry) {
      if (!Number.isInteger(entry.part) || entry.part < 0) throw new Error('invalid OTT part');
      const shard = await readJson(`${index.partsBase}/part-${entry.part}.json`);
      if (shard.version !== index.version) throw new Error('OTT generation changed');
      selected = shard.items.find(item => item.id === entry.id);
    }
  } else {
    items = (config.section === 'live' ? catalog.live : catalog.sports).filter(item => !config.group || (item.group || item.sport) === config.group);
    selected = items.find(item => item.title === title);
  }
  return { revision, section: config.section, title, defaultTitle: config.title,
    choices: items.map(item => ({ title: item.title })), item: selected?.playUrl ? selected : null };
}
