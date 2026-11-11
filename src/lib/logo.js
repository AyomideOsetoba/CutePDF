// The CutePDF mark: a rounded page with a folded corner and a little highlight swoosh.
export const LOGO_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="cpg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7b5cff"/>
      <stop offset="1" stop-color="#ff5fa2"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#cpg)"/>
  <path d="M22 15h14l9 9v22a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V19a4 4 0 0 1 4-4z" fill="#fff"/>
  <path d="M36 15v6a3 3 0 0 0 3 3h6" fill="#e7defe"/>
  <rect x="22.5" y="29" width="18" height="5" rx="2.5" fill="#ffd84d"/>
  <rect x="22.5" y="37" width="14" height="3" rx="1.5" fill="#cbbdf9"/>
  <rect x="22.5" y="43" width="16" height="3" rx="1.5" fill="#cbbdf9"/>
  <circle cx="27" cy="24" r="1.6" fill="#3a2a6b"/>
  <circle cx="35" cy="24" r="1.6" fill="#3a2a6b"/>
  <path d="M29 26.2q2 1.6 4 0" stroke="#3a2a6b" stroke-width="1.4" fill="none" stroke-linecap="round"/>
</svg>`;

export function logoSvg(cls) {
  const t = document.createElement('template');
  t.innerHTML = LOGO_SVG.trim();
  const svg = t.content.firstElementChild;
  if (cls) svg.setAttribute('class', cls);
  return svg;
}
