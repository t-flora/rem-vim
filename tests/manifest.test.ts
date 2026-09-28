/**
 * The RemNote Plugin Store validates manifest.json on upload with the app's
 * zod schema (read from the RemNote 1.28.28 bundle) and rejects the whole zip
 * on any violation — 0.2.3's first upload bounced on a 208-character
 * description. These are the limits a hand edit can realistically break.
 */
import { describe, expect, it } from 'vitest';
import manifest from '../public/manifest.json';

describe('public/manifest.json fits the Plugin Store schema', () => {
  it('description (the store listing one-liner) is at most 200 characters', () => {
    expect(manifest.description.length).toBeLessThanOrEqual(200);
  });

  it('id is 5-100 characters of letters, digits, - and _', () => {
    expect(manifest.id).toMatch(/^[-_a-zA-Z0-9]{5,100}$/);
  });

  it('name and author are 3-100 characters', () => {
    for (const field of [manifest.name, manifest.author]) {
      expect(field.length).toBeGreaterThanOrEqual(3);
      expect(field.length).toBeLessThanOrEqual(100);
    }
  });
});
