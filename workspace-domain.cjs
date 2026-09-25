/* Shared browser/import representation. Original source records stay unchanged. */
const workspaceDomain = (() => {
  const purposes = ['email', 'campaign', 'internal-note'];
  const cleanTitle = value => String(value || '').replace(/ — editable, unsent draft$/, '');
  const purpose = d => purposes.includes(d.purpose) ? d.purpose : d.kind === 'Proposed correction' || d.type === 'Proposed correction' ? 'internal-note' : 'email';
  function document(d, index = 0) {
    return {
      id: d.id || 'local-draft:' + index, purpose: purpose(d), title: cleanTitle(d.title || 'Untitled draft'),
      subject: d.subject ?? cleanTitle(d.title || ''), text: d.text || '', rationale: d.rationale || '',
      recipients: Array.isArray(d.recipients) ? d.recipients.map(r => r.email || r.name).filter(Boolean).join(', ') : d.recipients || '',
      cc: d.cc || '', bcc: d.bcc || '', internalNotes: d.internalNotes || '', campaignSender: d.campaignSender || '',
      company: d.company || 'No company linked', accountIds: d.accountIds || [],
      supportRefs: d.supportRefs || (Array.isArray(d.refs) ? d.refs : []), status: ['Draft', 'Ready for review', 'Archived'].includes(d.status) ? d.status : 'Draft',
      version: Number.isSafeInteger(d.version) ? d.version : 0, updatedAt: d.updatedAt || null,
      history: Array.isArray(d.history) ? d.history : [], contentMode: d.contentMode || 'default',
    };
  }
  function seeds(verified, records, revisions) {
    const company = ids => (ids || []).map(id => records.companies.find(c => 'company:' + c.id === id)?.name).filter(Boolean)[0] || 'No company linked';
    const originals = [...verified.drafts.map(x => x.draft), ...verified.presentation.suggestedDrafts.map((d, i) => ({ ...d, id: 'suggested-draft:' + i, version: 0 }))];
    return originals.map((original, index) => {
      const d = document({ ...original, company: company(original.accountIds) }, index);
      const retained = (verified.draftVersions[d.id] || []).map(x => ({ ...document({ ...x.draft, company: d.company }), savedAt: x.draft.updatedAt, origin: 'Retained source' }));
      const history = new Map(retained.map(h => [h.version, h]));
      history.set(d.version, { ...d, history: undefined, savedAt: original.updatedAt || '2026-09-08', origin: 'Original supplied draft' });
      const revision = revisions.drafts[d.id] || {};
      return { ...d, ...revision, history: [...history.values()], version: d.version + 1, updatedAt: revisions.updatedAt };
    });
  }
  function importLegacy(legacy, seedDrafts) {
    const all = [...seedDrafts, ...(legacy.newDrafts || []).map((d, i) => document(d, i))];
    const migrated = [];
    all.forEach((seed, i) => {
      const saved = legacy.savedState?.[i], edits = legacy.edits?.[i];
      if (!saved && !edits && i < seedDrafts.length) return;
      const personal = { ...seed, ...saved?.fields, ...edits };
      const existingHistory = [...seed.history || [], ...legacy.versionHistory?.[i] || []];
      if (saved) existingHistory.push({ ...seed, ...saved.fields, version: saved.version, savedAt: saved.savedAt, origin: 'Imported browser save', history: undefined });
      // Keep the exact personal content, including an unsaved edit, as the current imported revision.
      migrated.push(document({ ...personal, version: Math.max(seed.version, saved?.version || 0) + 1, history: existingHistory, updatedAt: new Date().toISOString() }, i));
    });
    const p = legacy.workspacePreferences || {};
    return {
      drafts: migrated,
      preferences: { mode: p.mode === 'marketing' ? 'marketing' : 'cs', ratings: p.ratings || {}, draftModes: p.draftModes || {}, priorityContext: p.priorityContext || {} },
      comments: Object.entries(p.comments || {}).flatMap(([priorityId, comments]) => Array.isArray(comments) ? comments.map(c => ({ ...c, priorityId })) : []),
    };
  }
  return { purposes, purpose, document, seeds, importLegacy };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = workspaceDomain;
