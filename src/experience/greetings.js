/**
 * The same word, thirty ways.
 *
 * Every entry is a greeting — "hello" — so the swarm always says one thing and
 * the reload only changes the voice it says it in. Scripts are limited to those
 * with near-universal system-font coverage (Latin, Cyrillic, Greek, Hebrew,
 * Arabic, Devanagari, Bengali, Tamil, Thai, Japanese, Korean, Chinese): the
 * browser does per-glyph fallback for us, but only if a font is actually there,
 * and a row of tofu boxes is not a greeting.
 *
 * Kept to single words wherever the language allows. A two-word greeting has to
 * be laid out much wider to stay legible, which costs the butterflies the size
 * they need to read as butterflies.
 */
export const GREETINGS = [
  { language: 'English', text: 'Hello' },
  { language: 'Spanish', text: 'Hola' },
  { language: 'French', text: 'Bonjour' },
  { language: 'German', text: 'Hallo' },
  { language: 'Italian', text: 'Ciao' },
  { language: 'Portuguese', text: 'Olá' },
  { language: 'Swedish', text: 'Hej' },
  { language: 'Finnish', text: 'Hei' },
  { language: 'Icelandic', text: 'Halló' },
  { language: 'Polish', text: 'Cześć' },
  { language: 'Czech', text: 'Ahoj' },
  { language: 'Romanian', text: 'Salut' },
  { language: 'Hungarian', text: 'Szia' },
  { language: 'Turkish', text: 'Merhaba' },
  { language: 'Esperanto', text: 'Saluton' },
  { language: 'Indonesian', text: 'Halo' },
  { language: 'Swahili', text: 'Jambo' },
  { language: 'Zulu', text: 'Sawubona' },
  { language: 'Hawaiian', text: 'Aloha' },
  { language: 'Vietnamese', text: 'Chào' },
  { language: 'Russian', text: 'Привет' },
  { language: 'Ukrainian', text: 'Привіт' },
  { language: 'Greek', text: 'Γειά' },
  { language: 'Hebrew', text: 'שלום' },
  { language: 'Arabic', text: 'مرحبا' },
  { language: 'Persian', text: 'سلام' },
  { language: 'Hindi', text: 'नमस्ते' },
  { language: 'Marathi', text: 'नमस्कार' },
  { language: 'Bengali', text: 'নমস্কার' },
  { language: 'Tamil', text: 'வணக்கம்' },
  { language: 'Thai', text: 'สวัสดี' },
  { language: 'Japanese', text: 'こんにちは' },
  { language: 'Korean', text: '안녕' },
  { language: 'Chinese', text: '你好' },
];

/** Glyph count, not code-unit count: 'こんにちは' is 5, not 10. */
export const glyphCount = (text) => [...text].length;

/**
 * Picks a greeting at random, never the one already on screen.
 *
 * `maxGlyphs` exists for narrow screens: a long word laid across a phone has to
 * shrink so far that neither the letters nor the butterflies survive it.
 * `unavailable` collects words this system turned out to have no font for.
 */
export function pickGreeting(rng, { maxGlyphs = Infinity, exclude = null, unavailable = null } = {}) {
  // Each filter is allowed to fail open: a screen too narrow for any word, or a
  // system missing every font, must still get a greeting rather than nothing.
  let pool = GREETINGS.filter((g) => glyphCount(g.text) <= maxGlyphs);
  if (pool.length === 0) pool = GREETINGS;

  if (unavailable?.size) {
    const drawable = pool.filter((g) => !unavailable.has(g.text));
    if (drawable.length > 0) pool = drawable;
  }

  const fresh = pool.filter((g) => g.text !== exclude);
  const from = fresh.length > 0 ? fresh : pool;

  return from[Math.min(from.length - 1, Math.floor(rng() * from.length))];
}
