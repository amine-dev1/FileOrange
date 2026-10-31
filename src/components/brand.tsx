/** Brand glyphs. Drawn as SVG so they stay crisp at any scale. */

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M3 8.5A3.5 3.5 0 0 1 6.5 5h5.6c.9 0 1.7.4 2.3 1l1.4 1.5H25.5A3.5 3.5 0 0 1 29 11v13.5a3.5 3.5 0 0 1-3.5 3.5h-19A3.5 3.5 0 0 1 3 24.5v-16Z" fill="#F9A04E" />
      <path d="M3 13.5A3.5 3.5 0 0 1 6.5 10h19a3.5 3.5 0 0 1 3.5 3.5V24.5a3.5 3.5 0 0 1-3.5 3.5h-19A3.5 3.5 0 0 1 3 24.5v-11Z" fill="#F47B20" />
      <path d="M23.8 13.2h2.4v2.4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".85" />
    </svg>
  );
}

/** Orange document with an up-arrow, used in the drop zone. */
export function UploadFileGlyph({ width = 52 }: { width?: number }) {
  return (
    <svg width={width} height={(width * 66) / 52} viewBox="0 0 52 66" aria-hidden>
      <path d="M8 0h24l20 20v38a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8V8a8 8 0 0 1 8-8Z" fill="#F47B20" />
      <path d="M32 0l20 20H40a8 8 0 0 1-8-8V0Z" fill="#FBB77C" />
      <path d="M26 53V32m0 0-9 9m9-9 9 9" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
