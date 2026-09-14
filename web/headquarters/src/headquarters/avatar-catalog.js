/** Original Workforce illustrations, pre-rendered and served from this installation. */
export const avatarCatalog = Object.freeze([
  ['portrait-01', 'Avery', 'Short waves · indigo'],
  ['portrait-02', 'Maya', 'Long hair · rose'],
  ['portrait-03', 'Leo', 'Curls · sky'],
  ['portrait-04', 'Zara', 'Bob · lilac'],
  ['portrait-05', 'Omar', 'Beard · teal'],
  ['portrait-06', 'Nia', 'Long hair · peach'],
  ['portrait-07', 'Kai', 'Swept hair · mint'],
  ['portrait-08', 'Sofia', 'Bob · blue'],
  ['portrait-09', 'Elias', 'Short waves · sand'],
  ['portrait-10', 'Amara', 'Curls · violet'],
  ['portrait-11', 'Noah', 'Glasses · teal'],
  ['portrait-12', 'Lina', 'Long hair · lavender'],
  ['portrait-13', 'Arjun', 'Beard · blue'],
  ['portrait-14', 'Iris', 'Bob · apricot'],
  ['portrait-15', 'Theo', 'Swept hair · rose'],
  ['portrait-16', 'Freya', 'Curls · mint'],
].map(([id, label, description]) => Object.freeze({ id, label, description, src: `/src/headquarters/assets/avatars/${id}.svg` })));

const portraits = new Map(avatarCatalog.map(portrait => [portrait.id, portrait]));
export const portraitById = id => portraits.get(id) || null;

// A stable id wins over a name; duplicate names never borrow each other's portrait.
const byId = new Map();
const byName = new Map();
export function setAvatarProfiles(profiles = []) {
  byId.clear(); byName.clear();
  for (const profile of profiles) {
    if (profile.id) byId.set(profile.id, profile.avatarId || null);
    if (profile.name) byName.set(profile.name, byName.has(profile.name) ? null : profile.avatarId || null);
    if (profile.isCoordinator) byName.set('Control Center', profile.avatarId || null);
  }
}
export function resolveAvatarId(name, identity) {
  if (identity && typeof identity === 'object' && Object.hasOwn(identity, 'avatarId') && identity.avatarId !== undefined) return portraitById(identity.avatarId)?.id || null;
  const id = typeof identity === 'string' ? identity : identity?.id;
  if (id && byId.has(id)) return portraitById(byId.get(id))?.id || null;
  return portraitById(byName.get(name))?.id || null;
}
