/** Original 3D-rendered human expression sprites, bundled for offline use. */
export const avatarCatalog = Object.freeze([
  ['portrait-01', 'Avery', 'Short waves · indigo'],
  ['portrait-02', 'Maya', 'Long hair · rose'],
  ['portrait-03', 'Leo', 'Curls · sky'],
  ['portrait-04', 'Zara', 'Bob · lilac'],
  ['portrait-05', 'Omar', 'Beard · teal'],
  ['portrait-06', 'Nia', 'Braids · peach'],
  ['portrait-07', 'Kai', 'Swept hair · mint'],
  ['portrait-08', 'Sofia', 'Bob · blue'],
  ['portrait-09', 'Elias', 'Silver waves · sand'],
  ['portrait-10', 'Amara', 'Curls · violet'],
  ['portrait-11', 'Noah', 'Glasses · teal'],
  ['portrait-12', 'Lina', 'Long hair · lavender'],
  ['portrait-13', 'Arjun', 'Beard · blue'],
  ['portrait-14', 'Iris', 'Auburn bob · glasses'],
  ['portrait-15', 'Theo', 'Sandy swept hair · rose'],
  ['portrait-16', 'Freya', 'Copper curls · mint'],
].map(([id, label, description]) => Object.freeze({ id, label, description, src: `/src/headquarters/assets/avatars-3d/${id}.webp`, spriteSrc: `/src/headquarters/assets/avatars-3d/${id}.webp`, frameCount: 4, presentation: '3d-human' })));

const portraits = new Map(avatarCatalog.map(portrait => [portrait.id, portrait]));
export const portraitById = id => portraits.get(id) || null;

// A stable id wins over a name; duplicate names never borrow each other's portrait.
const byId = new Map();
const byName = new Map();
const automaticSeed = value => {
  const normalized = String(value || 'agent').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hash = [...normalized].reduce((number, character) => (Math.imul(number, 31) + character.charCodeAt(0)) >>> 0, 7);
  return (Math.imul(hash ^ (hash >>> 16), 2246822507) >>> 0) % avatarCatalog.length;
};
/** Automatic visual identity changes no saved workspace configuration. Stable ids survive renames. */
export function defaultPortrait(name, identity) {
  const id = typeof identity === 'string' ? identity : identity?.id;
  const profile = byName.get(name);
  return avatarCatalog[automaticSeed(id || profile?.id || name)];
}
export function setAvatarProfiles(profiles = []) {
  byId.clear(); byName.clear();
  for (const profile of profiles) {
    if (profile.id) byId.set(profile.id, profile.avatarId || null);
    if (profile.name) byName.set(profile.name, byName.has(profile.name) ? null : { id: profile.id, avatarId: profile.avatarId || null });
    if (profile.isCoordinator) byName.set('Control Center', { id: profile.id, avatarId: profile.avatarId || null });
  }
}
export function resolveAvatarId(name, identity) {
  if (identity && typeof identity === 'object' && Object.hasOwn(identity, 'avatarId') && identity.avatarId !== undefined) return portraitById(identity.avatarId)?.id || defaultPortrait(name, identity).id;
  const id = typeof identity === 'string' ? identity : identity?.id;
  if (id) return portraitById(byId.get(id))?.id || defaultPortrait(name, identity).id;
  return portraitById(byName.get(name)?.avatarId)?.id || defaultPortrait(name, identity).id;
}
