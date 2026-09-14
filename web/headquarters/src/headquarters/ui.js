import { portraitById, resolveAvatarId } from './avatar-catalog.js';
import { renderAnimatedAvatar } from './avatar-animation.js';
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  archive:'M3 4h18v4H3ZM5 8v12h14V8M10 12h4', settings:'M4 7h16M4 17h16M8 4v6M16 14v6', sun:'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', moon:'M20 15.8A9 9 0 0 1 8.2 4 9 9 0 1 0 20 15.8Z', monitor:'M3 4h18v13H3ZM8 21h8M12 17v4', palette:'M21 12a9 9 0 1 0-9 9h1a2 2 0 0 0 2-2c0-1-1-2-1-3s1-2 2-2h3a2 2 0 0 0 2-2ZM7 10h.01M9 6h.01M14 6h.01M17 10h.01', play:'m8 4 12 8-12 8Z',
  spark:'M12 2v20M2 12h20M5 5l14 14M5 19 19 5', home:'m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z', grid:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z', tasks:'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1', people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M15 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', check:'m5 12 4 4L19 6', circleCheck:'M21 11v1a9 9 0 1 1-5.3-8.2M21 3 11 13l-3-3', book:'M4 3h6a3 3 0 0 1 3 3v15a4 4 0 0 0-4-2H3V4a1 1 0 0 1 1-1Zm9 3a3 3 0 0 1 3-3h5v16h-4a4 4 0 0 0-4 2', search:'m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0', code:'m8 5-7 7 7 7M16 5l7 7-7 7M14 3l-4 18', pen:'m15 4 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15Z', megaphone:'m3 10 17-6v16L3 14ZM6 15l2 6h4l-2-5M20 8h2v8h-2', layers:'m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5', headphones:'M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v9H3ZM17 12h4v9h-4Z', chevron:'m9 5 7 7-7 7', down:'m7 10 5 5 5-5', plus:'M12 5v14M5 12h14', arrow:'M5 12h14m-5-5 5 5-5 5', arrowUp:'M12 19V5m-6 6 6-6 6 6', northeast:'M6 18 18 6M6 6h12v12', bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4', panel:'M3 3h18v18H3ZM15 3v18', org:'M9 2h6v5H9ZM2 17h6v5H2ZM16 17h6v5h-6ZM12 7v5M5 17v-5h14v5', clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2', file:'M14 2H4v20h16V8ZM14 2v6h6M8 13h8M8 17h5', download:'M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6', back:'M19 12H5m6-6-6 6 6 6', close:'m6 6 12 12M6 18 18 6', shield:'m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Zm-4 9 3 3 5-5', flag:'M4 22V3m0 1c6-5 10 5 16 0v10c-6 5-10-5-16 0', board:'M3 3h18v18H3ZM9 3v18M15 3v18', coffee:'M4 8h12v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Zm12 1h2a3 3 0 0 1 0 6h-2M7 2v3M12 2v3', connect:'M8 12h8M9 5H6a7 7 0 0 0 0 14h3M15 5h3a7 7 0 0 1 0 14h-3', globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18', reset:'M3 3v6h6M3 9a9 9 0 1 1 .7 8', eye:'M2 12S6 5 12 5s10 7 10 7-4 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'
};
export const icon = (name,cls='') => `<svg class="icon ${cls}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name] || icons.grid}"/></svg>`;
export const atlasMark = () => `<span class="atlas-mark"><img src="./assets/atlas-mark.svg" alt=""></span>`;
// Illustrated identities are deterministic across the directory, workspace, and chat.
export function avatar(name, size = 28, identity) {
  const portrait = portraitById(resolveAvatarId(name, identity));
  if (portrait?.spriteSrc) return renderAnimatedAvatar(portrait, size, typeof identity === 'object' ? identity?.id || name : identity || name);
  if (portrait) {
    const dimension = Math.max(16, Math.min(160, Number(size) || 28));
    return `<span class="avatar avatar-portrait" data-avatar-id="${portrait.id}" style="width:${dimension}px;height:${dimension}px" aria-hidden="true"><img src="${portrait.src}" width="${dimension}" height="${dimension}" alt="" decoding="async"></span>`;
  }
  const hash = [...String(name || 'Agent')].reduce((value, character) => (Math.imul(value, 31) + character.charCodeAt(0)) >>> 0, 7);
  const dimension = Math.max(16, Math.min(160, Number(size) || 28));
  const backgrounds = [['#E9EBDD', '#D8DECA'], ['#E4EAF0', '#CFDCE8'], ['#EEE3DC', '#E1CEBF'], ['#EAE4EF', '#DACEDE'], ['#E1ECE7', '#C9DFD2'], ['#F0E9D8', '#E5D9B9']];
  const skins = [['#F0C7A5', '#D99F7D'], ['#DAA07D', '#BD7D5B'], ['#AC7252', '#865137'], ['#87543E', '#663C2D'], ['#E1B18D', '#BE8768'], ['#C18B68', '#A0694E']];
  const shirts = [['#5C776C', '#78968A'], ['#5C708E', '#7D90A9'], ['#9D7464', '#B28E7D'], ['#857693', '#A092AE'], ['#59646B', '#7C878E'], ['#A08A58', '#BBA573']];
  const hairColors = ['#39312D', '#514037', '#292E30', '#695042', '#7E6D58', '#665653'];
  const background = backgrounds[hash % backgrounds.length];
  const skin = skins[(hash >>> 4) % skins.length];
  const shirt = shirts[(hash >>> 8) % shirts.length];
  const hair = hairColors[(hash >>> 12) % hairColors.length];
  const style = (hash >>> 16) % 6;
  const glasses = hash % 7 === 0;
  const backHair = style === 1 ? `<path d="M16 29C11 7 49 4 49 28l2 26-11-1-5-12H24l-7 12-4-2Z" fill="${hair}"/>` : style === 2 ? `<path d="M16 19C18 5 48 7 48 24v19q-3 8-10 8H23q-10-4-10-14Z" fill="${hair}"/>` : style === 5 ? `<path d="M15 21q-6-5 0-10-2-8 6-7 4-7 10-3 8-5 11 2 9-1 9 7 6 5 0 11Z" fill="${hair}"/>` : '';
  const hairFront = [
    `<path d="M18 27C12 12 24 6 36 9q15 0 12 17l-5-5q-8 0-15-8-2 10-10 14Z" fill="${hair}"/>`,
    `<path d="M18 30C9 12 30 2 43 12q8 7 4 18l-4-11q-8 1-11-7-2 11-13 14Z" fill="${hair}"/>`,
    `<path d="M17 29C11 8 46 4 49 25l-6-4-5-9q-2 10-20 12Z" fill="${hair}"/>`,
    `<path d="M18 29q-7-16 4-20 3-6 10-2 14-3 16 10v13l-5-9q-10 4-19-4l-4 12Z" fill="${hair}"/><path d="M23 13q10 7 18 2" stroke="#ffffff" stroke-opacity=".12" stroke-width="2" fill="none"/>`,
    `<path d="M18 29q-6-13 3-18l1 8-3 10ZM43 12q7 5 4 17h-3l-2-10Z" fill="${hair}"/>`,
    `<path d="M17 25q-6-5 0-9-1-7 6-7 5-6 11-1 8-4 11 4 8 3 2 12l-5-5q-9 4-15-4-4 7-10 10Z" fill="${hair}"/>`,
  ][style];
  return `<span class="avatar avatar-illustrated" style="width:${dimension}px;height:${dimension}px;--av-blink-period:${5.4 + hash % 27 / 10}s;--av-blink-delay:-${hash % 5100}ms;--av-tilt:${hash % 2 ? '-3' : '3'}deg" aria-hidden="true">
    <svg class="av-illustration" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
      <rect width="64" height="64" rx="32" fill="${background[0]}"/>
      <path d="M0 46q29-15 64-4v22H0Z" fill="${background[1]}"/>
      <path d="M7 64v-4q2-11 18-13h14q16 2 18 13v4Z" fill="${shirt[0]}"/>
      <path d="M25 40h14v11q-7 8-14 0Z" fill="${skin[0]}"/>
      <path d="M25 42q7 7 14 0v5q-6 6-14-1Z" fill="${skin[1]}"/>
      <path d="m24 48 8 7-7 6-6-12ZM40 48l-8 7 7 6 6-12Z" fill="${shirt[1]}"/>
      <path d="M32 55v9" stroke="${shirt[1]}" stroke-width="1.1"/>
      <g class="av-head">
        ${backHair}
        <ellipse cx="18.5" cy="29" rx="3.4" ry="4.7" fill="${skin[1]}"/>
        <ellipse cx="45.5" cy="29" rx="3.4" ry="4.7" fill="${skin[1]}"/>
        <path d="M19 24q0-14 13-14t13 14v8q-1 14-13 15-12-1-13-15Z" fill="${skin[0]}"/>
        <path d="M37 11q8 3 8 14v7q-1 14-13 15l-3-1q13-4 12-18-1-10-4-17Z" fill="${skin[1]}" opacity=".43"/>
        ${hairFront}
        <path class="av-brows" d="M23 24q3-2 6-.5M35 23.5q3-1.5 6 .5" stroke="${hair}" stroke-width="1.35" stroke-linecap="round"/>
        <g class="av-eyes">
          <ellipse cx="26.5" cy="28.5" rx="2.55" ry="1.8" fill="#FFFAF1"/>
          <ellipse cx="37.5" cy="28.5" rx="2.55" ry="1.8" fill="#FFFAF1"/>
          <ellipse cx="27" cy="28.5" rx="1.35" ry="1.7" fill="#342F2D"/>
          <ellipse cx="38" cy="28.5" rx="1.35" ry="1.7" fill="#342F2D"/>
          <circle cx="27.5" cy="28" r=".4" fill="#FFF"/><circle cx="38.5" cy="28" r=".4" fill="#FFF"/>
        </g>
        <path d="m32 29-1.2 5 2.7.4" stroke="${skin[1]}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
        ${style === 4 ? `<path d="M21 35q4 1 5 4h12q3-4 5-4-2 10-11 11-9-2-11-11Z" fill="${hair}" opacity=".8"/>` : `<ellipse cx="23.5" cy="34" rx="2.7" ry="1.3" fill="${skin[1]}" opacity=".25"/><ellipse cx="40.5" cy="34" rx="2.7" ry="1.3" fill="${skin[1]}" opacity=".2"/>`}
        <path class="av-smile" d="M28 38q4 3.5 8 0" stroke="${style === 4 ? skin[0] : '#8F5547'}" stroke-width="1.45" stroke-linecap="round"/>
        ${glasses ? `<g stroke="${hair}" stroke-width="1.1"><rect x="21.5" y="25.5" width="9.3" height="7" rx="2.4"/><rect x="33.2" y="25.5" width="9.3" height="7" rx="2.4"/><path d="M30.8 28h2.4M18 27l3.5 1M42.5 28l3.5-1"/></g>` : ''}
      </g>
    </svg>
  </span>`;
}
