export function parseWindowsGroups(value = 'shell') {
  if (value === 'full') return ['shell','notes','canvas','library','workspace'];
  const groups = [...new Set(value.split(',').filter(Boolean))].sort();
  if (!groups.length || groups.some(g => !['shell','notes','canvas','library','workspace'].includes(g))) throw new Error('Invalid Windows web scope');
  return groups;
}
